// =============================================================================
// GENHUB - Payment gateway health
// GET /api/payments/health (ADMIN)
//
// Answers the question "why does no USSD push reach my phone?" in one call:
//   * sandbox mode (no real charge is ever attempted)
//   * whether the gateway credentials + webhook verification are configured
//   * whether the app URL is publicly reachable (webhooks) or local-only
//   * whether recent charges ever settled, and how many are under investigation
//
// ClickPesa exposes no balance/float endpoint (collections settle straight into
// the merchant account), so there is no live balance read here — the delivery
// counters below are the equivalent early warning.
//
// Never returns the API key or client id itself.
// =============================================================================

import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import {
  clickpesaGatewayState,
  clickpesaBreakerNotice,
} from "@/lib/payments/clickpesa";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const appUrl = config.appUrl;
    const isLocal = /localhost|127\.0\.0\.1/i.test(appUrl);
    const sandbox = config.clickPesa.sandbox;
    const usesChecksum = Boolean(config.clickPesa.checksumKey);

    const checks = {
      sandboxMode: {
        ok: !sandbox,
        value: sandbox,
        hint: sandbox
          ? "PAYMENT_SANDBOX=true — the app never contacts ClickPesa, so no USSD push is sent. Set PAYMENT_SANDBOX=false to charge real phones."
          : "Live mode — purchases send a real USSD push.",
      },
      clientId: {
        ok: !!config.clickPesa.clientId,
        value: config.clickPesa.clientId ? "configured" : "missing",
        hint: config.clickPesa.clientId
          ? "CLICKPESA_CLIENT_ID is set."
          : "Set CLICKPESA_CLIENT_ID (ClickPesa dashboard → API Integration Setup).",
      },
      apiKey: {
        ok: !!config.clickPesa.apiKey,
        value: config.clickPesa.apiKey ? "configured" : "missing",
        hint: config.clickPesa.apiKey
          ? "CLICKPESA_API_KEY is set."
          : "Set CLICKPESA_API_KEY (ClickPesa dashboard → API Integration Setup).",
      },
      baseUrl: {
        ok: !!config.clickPesa.baseUrl,
        value: config.clickPesa.baseUrl,
        hint: "ClickPesa API base URL.",
      },
      webhookVerification: {
        ok: usesChecksum || !!config.clickPesa.webhookToken,
        value: usesChecksum
          ? "checksum (CLICKPESA_CHECKSUM_KEY)"
          : config.clickPesa.webhookToken
            ? "shared token (CLICKPESA_WEBHOOK_TOKEN)"
            : "missing",
        hint: usesChecksum
          ? "Every callback must carry a valid HMAC-SHA256 checksum."
          : config.clickPesa.webhookToken
            ? "Callbacks are verified by the ?t= token in the webhook URL. Add CLICKPESA_CHECKSUM_KEY for signature verification."
            : "Set CLICKPESA_CHECKSUM_KEY (preferred) or CLICKPESA_WEBHOOK_TOKEN, or callbacks cannot be verified.",
      },
      appUrl: {
        ok: !isLocal && config.appUrlSource === "NEXT_PUBLIC_APP_URL",
        value: appUrl,
        source: config.appUrlSource,
        hint: isLocal
          ? "The app URL is localhost, so ClickPesa cannot reach /api/webhooks/clickpesa. Payments still confirm because the client polls /api/payments/status, which reconciles with the gateway. Set NEXT_PUBLIC_APP_URL to the public domain."
          : config.appUrlSource === "NEXT_PUBLIC_APP_URL"
            ? "Public URL from NEXT_PUBLIC_APP_URL — webhooks can reach this deployment."
            : `Public URL inferred from ${config.appUrlSource}. It works, but set NEXT_PUBLIC_APP_URL explicitly so the webhook URL never depends on the hosting provider.`,
      },
    };

    // The local circuit breaker. When it is open, gateway calls are being
    // *skipped*, which would otherwise look like a gateway fault with no cause.
    const breaker = clickpesaGatewayState();
    const breakerWarning = clickpesaBreakerNotice(breaker);

    const readyForLive =
      !sandbox &&
      checks.clientId.ok &&
      checks.apiKey.ok &&
      checks.webhookVerification.ok;

    // Orders accepted but never delivered are the classic "unfunded / not yet
    // activated merchant account" symptom. Surface them here instead of leaving
    // it invisible.
    const staleCutoff = new Date(Date.now() - 15 * 60_000);
    const [stuckPending, lastSettled, underInvestigation] = await Promise.all([
      prisma.transaction.count({
        where: {
          status: "PENDING",
          gateway: "CLICKPESA",
          createdAt: { lt: staleCutoff },
        },
      }),
      prisma.transaction.findFirst({
        where: { gateway: "CLICKPESA", status: "SUCCESS" },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, amount: true },
      }),
      // Charges a customer approved but the gateway never settled. Money may
      // already have left their handset, so this is an operational queue, not a
      // statistic — surfaced here so it cannot hide inside the admin panel.
      prisma.transaction.count({ where: { status: "UNDER_INVESTIGATION" } }),
    ]);

    const deliveryWarning =
      !sandbox && stuckPending > 0
        ? `${stuckPending} ClickPesa order(s) have been PENDING for over 15 minutes. ` +
          "If customers never see a USSD prompt, confirm with ClickPesa that live " +
          "collections are activated on your account and that the application is set " +
          "up for USSD push. Share the order references as evidence."
        : null;

    return api.success({
      readyForLive,
      gateway: "CLICKPESA",
      checks,
      delivery: {
        stuckPending,
        deliveryWarning,
        lastSuccessfulPaymentAt: lastSettled?.updatedAt ?? null,
        lastSuccessfulPaymentAmount: lastSettled?.amount ?? null,
        underInvestigation,
        investigationWarning:
          !sandbox && underInvestigation > 0
            ? `${underInvestigation} charge(s) were approved on the customer's phone but never settled. ` +
              "These customers have been told not to pay again — resolve each one in Admin → Payments → Being checked."
            : null,
      },
      gatewayBreaker: {
        open: breaker.open,
        openUntil: breaker.open ? new Date(breaker.openUntil).toISOString() : null,
        failures: breaker.failures,
        skipped: breaker.skipped,
        warning: breakerWarning,
      },
      // The breaker leads when it is open: every other line is about a gateway
      // the operator cannot currently reach, and reading them first sends
      // somebody after the wrong fault.
      summary: breakerWarning
        ? breakerWarning
        : readyForLive
          ? deliveryWarning
            ? "Live payments are on, but recent orders never settled — see delivery.deliveryWarning."
            : "Live payments are ready: a purchase will send a real USSD push to the customer's phone."
          : sandbox
            ? "Sandbox is ON: no USSD push is sent and no money moves. Set PAYMENT_SANDBOX=false to go live."
            : "Live mode is on but one or more checks failed — see checks above.",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Payment Health Error]", error);
    return api.internal();
  }
}
