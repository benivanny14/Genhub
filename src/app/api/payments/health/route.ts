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
// SonicPesa exposes no balance/float endpoint (collections settle straight into
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
  sonicpesaGatewayState,
  sonicpesaBreakerNotice,
} from "@/lib/payments/sonicpesa";
import { classifyGatewayFailure } from "@/lib/gateway-failure";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const appUrl = config.appUrl;
    const isLocal = /localhost|127\.0\.0\.1/i.test(appUrl);
    const sandbox = config.sonicPesa.sandbox;
    const usesSignature = Boolean(config.sonicPesa.secretKey);

    const checks = {
      sandboxMode: {
        ok: !sandbox,
        value: sandbox,
        hint: sandbox
          ? "PAYMENT_SANDBOX=true — the app never contacts SonicPesa, so no USSD push is sent. Set PAYMENT_SANDBOX=false to charge real phones."
          : "Live mode — purchases send a real USSD push.",
      },
      accessKey: {
        ok: !!config.sonicPesa.accessKey,
        value: config.sonicPesa.accessKey ? "configured" : "missing",
        hint: config.sonicPesa.accessKey
          ? "SONICPESA_ACCESS_KEY is set."
          : "Set SONICPESA_ACCESS_KEY (SonicPesa dashboard → API Settings).",
      },
      baseUrl: {
        ok: !!config.sonicPesa.baseUrl,
        value: config.sonicPesa.baseUrl,
        hint: "SonicPesa API base URL.",
      },
      webhookVerification: {
        ok: usesSignature || !!config.sonicPesa.webhookToken,
        value: usesSignature
          ? "signature (SONICPESA_SECRET_KEY)"
          : config.sonicPesa.webhookToken
            ? "shared token (SONICPESA_WEBHOOK_TOKEN)"
            : "missing",
        hint: usesSignature
          ? "Every callback must carry a valid X-SonicPesa-Signature (HMAC-SHA256)."
          : config.sonicPesa.webhookToken
            ? "Callbacks are verified by the ?t= token in the webhook URL. Add SONICPESA_SECRET_KEY for signature verification."
            : "Set SONICPESA_SECRET_KEY (preferred) or SONICPESA_WEBHOOK_TOKEN, or callbacks cannot be verified.",
      },
      appUrl: {
        ok: !isLocal && config.appUrlSource === "NEXT_PUBLIC_APP_URL",
        value: appUrl,
        source: config.appUrlSource,
        hint: isLocal
          ? "The app URL is localhost, so SonicPesa cannot reach /api/webhooks/sonicpesa. Payments still confirm because the client polls /api/payments/status, which reconciles with the gateway. Set NEXT_PUBLIC_APP_URL to the public domain."
          : config.appUrlSource === "NEXT_PUBLIC_APP_URL"
            ? "Public URL from NEXT_PUBLIC_APP_URL — webhooks can reach this deployment."
            : `Public URL inferred from ${config.appUrlSource}. It works, but set NEXT_PUBLIC_APP_URL explicitly so the webhook URL never depends on the hosting provider.`,
      },
    };

    // The local circuit breaker. When it is open, gateway calls are being
    // *skipped*, which would otherwise look like a gateway fault with no cause.
    const breaker = sonicpesaGatewayState();
    const breakerWarning = sonicpesaBreakerNotice(breaker);

    const readyForLive =
      !sandbox &&
      checks.accessKey.ok &&
      checks.webhookVerification.ok;

    // Orders accepted but never delivered are the classic "unfunded / not yet
    // activated merchant account" symptom. Surface them here instead of leaving
    // it invisible.
    const staleCutoff = new Date(Date.now() - 15 * 60_000);
    const [stuckPending, lastSettled, underInvestigation] = await Promise.all([
      prisma.transaction.count({
        where: {
          status: "PENDING",
          gateway: "SONICPESA",
          createdAt: { lt: staleCutoff },
        },
      }),
      prisma.transaction.findFirst({
        where: { gateway: "SONICPESA", status: "SUCCESS" },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, amount: true },
      }),
      // Charges a customer approved but the gateway never settled. Money may
      // already have left their handset, so this is an operational queue, not a
      // statistic — surfaced here so it cannot hide inside the admin panel.
      prisma.transaction.count({ where: { status: "UNDER_INVESTIGATION" } }),
    ]);

    // Collects refused because of OUR merchant account (the pre-KYC daily API cap,
    // an unfinished account) rather than anything about the customer. This is the
    // one fault that makes EVERY checkout fail identically until it clears, so it
    // gets its own line here — the customer-facing side now answers with a plain
    // "try later", which means without this the operator would see a quiet day
    // rather than an outage.
    const recentFailures = await prisma.transaction.findMany({
      where: {
        gateway: "SONICPESA",
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { metadata: true },
    });

    let accountFaults = 0;
    let accountFaultSample = "";
    for (const row of recentFailures) {
      const raw = (row.metadata as { gatewayError?: string } | null)?.gatewayError;
      const failure = classifyGatewayFailure(raw);
      if (failure.kind === "account-limit" || failure.kind === "account-setup") {
        accountFaults += 1;
        if (!accountFaultSample) accountFaultSample = failure.gatewayMessage;
      }
    }

    const accountFaultWarning =
      !sandbox && accountFaults > 0
        ? `${accountFaults} charge(s) in the last 24h were refused because of THIS account, ` +
          "not the customer's: " +
          accountFaultSample +
          " Until that clears, every mobile-money checkout fails the same way — complete " +
          "your SonicPesa KYC to lift the 100-calls-per-day cap. Customers are told nothing " +
          "was charged and to try later."
        : null;

    const deliveryWarning =
      !sandbox && stuckPending > 0
        ? `${stuckPending} SonicPesa order(s) have been PENDING for over 15 minutes. ` +
          "If customers never see a USSD prompt, confirm with SonicPesa that live " +
          "collections are activated on your account and that the application is set " +
          "up for USSD push. Share the order references as evidence."
        : null;

    return api.success({
      readyForLive,
      gateway: "SONICPESA",
      checks,
      delivery: {
        stuckPending,
        deliveryWarning,
        accountFaults,
        accountFaultWarning,
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
      // The account fault leads over the delivery warning: a customer never seeing
      // a prompt is a symptom, and this is the cause when it is present.
      summary: breakerWarning
        ? breakerWarning
        : accountFaultWarning
          ? accountFaultWarning
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
