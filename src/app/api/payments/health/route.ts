// =============================================================================
// GENHUB - Payment gateway health
// GET /api/payments/health (ADMIN)
//
// Answers the question "why does no USSD push reach my phone?" in one call:
//   * sandbox mode (no real charge is ever attempted)
//   * whether the gateway key/webhook token are configured
//   * whether the app URL is publicly reachable (webhooks) or local-only
//   * the live HarakaPay wallet/float balance, straight from the gateway
// Never returns the API key itself.
// =============================================================================

import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import {
  harakaBalance,
  harakaErrorReason,
  harakaGatewayState,
  harakaBreakerNotice,
} from "@/lib/payments/harakapay";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const appUrl = config.appUrl;
    const isLocal = /localhost|127\.0\.0\.1/i.test(appUrl);
    const sandbox = config.harakaPay.sandbox;

    const checks = {
      sandboxMode: {
        ok: !sandbox,
        value: sandbox,
        hint: sandbox
          ? "PAYMENT_SANDBOX=true — the app never contacts HarakaPay, so no USSD push is sent. Set PAYMENT_SANDBOX=false to charge real phones."
          : "Live mode — purchases send a real USSD push.",
      },
      apiKey: {
        ok: !!config.harakaPay.apiKey,
        value: config.harakaPay.apiKey ? "configured" : "missing",
        hint: config.harakaPay.apiKey ? "HARAKAPAY_API_KEY is set." : "Set HARAKAPAY_API_KEY.",
      },
      baseUrl: {
        ok: !!config.harakaPay.baseUrl,
        value: config.harakaPay.baseUrl,
        hint: "HarakaPay API base URL.",
      },
      webhookToken: {
        ok: !!config.harakaPay.webhookToken,
        value: config.harakaPay.webhookToken ? "configured" : "missing",
        hint: "Shared token appended to the webhook URL (?t=…).",
      },
      appUrl: {
        ok: !isLocal && config.appUrlSource === "NEXT_PUBLIC_APP_URL",
        value: appUrl,
        source: config.appUrlSource,
        hint: isLocal
          ? "The app URL is localhost, so HarakaPay cannot reach /api/webhooks/harakapay. Payments still confirm because the client polls /api/payments/status, which reconciles with the gateway. Set NEXT_PUBLIC_APP_URL to the public domain."
          : config.appUrlSource === "NEXT_PUBLIC_APP_URL"
            ? "Public URL from NEXT_PUBLIC_APP_URL — webhooks can reach this deployment."
            : `Public URL inferred from ${config.appUrlSource}. It works, but set NEXT_PUBLIC_APP_URL explicitly so the webhook_url never depends on the hosting provider.`,
      },
    };

    // Live gateway read-only check: proves the key works and shows the float.
    let balance: {
      ok: boolean;
      wallet_balance?: number;
      float_balance?: number;
      error?: string;
    } = { ok: false, error: "skipped (sandbox mode)" };

    if (config.harakaPay.apiKey && !sandbox) {
      try {
        const res = await harakaBalance();
        balance = {
          ok: !!res.success,
          wallet_balance: res.wallet_balance,
          float_balance: res.float_balance,
          error: res.success ? undefined : res.error,
        };
      } catch (error) {
        balance = { ok: false, error: harakaErrorReason(error) };
      }
    }

    // An empty merchant float is the most common reason a live collect is
    // accepted by the API but never has money behind it.
    const floatEmpty =
      balance.ok === true &&
      (balance.float_balance ?? 0) <= 0 &&
      (balance.wallet_balance ?? 0) <= 0;

    // Read AFTER the balance attempt, so a failure from this very call is
    // included — the state an operator is looking at is the state that produced
    // what they just saw.
    const breaker = harakaGatewayState();
    const breakerWarning = harakaBreakerNotice(breaker);

    const readyForLive =
      !sandbox && checks.apiKey.ok && checks.baseUrl.ok && balance.ok === true;

    // The symptom of an unfunded / not-yet-activated merchant account: orders are
    // accepted ("USSD push sent") but never reach the handset, so nothing ever
    // settles. Surface it here instead of leaving it invisible.
    const staleCutoff = new Date(Date.now() - 15 * 60_000);
    const [stuckPending, lastSettled, underInvestigation] = await Promise.all([
      prisma.transaction.count({
        where: {
          status: "PENDING",
          gateway: "HARAKAPAY",
          createdAt: { lt: staleCutoff },
        },
      }),
      prisma.transaction.findFirst({
        where: { gateway: "HARAKAPAY", status: "SUCCESS" },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true, amount: true },
      }),
      // Charges a customer approved but the gateway never settled. Money may
      // already have left their handset, so this is an operational queue, not a
      // statistic — surfaced here so it cannot hide inside the admin panel.
      prisma.transaction.count({
        where: { status: "UNDER_INVESTIGATION" },
      }),
    ]);

    const deliveryWarning =
      !sandbox && stuckPending > 0
        ? `${stuckPending} HarakaPay order(s) have been PENDING for over 15 minutes. ` +
          "If customers never see a USSD prompt, the merchant account needs attention: " +
          "confirm with HarakaPay that live collections are activated, that the key is a " +
          "production key, and that the merchant float is funded. Share the order ids as evidence."
        : null;

    return api.success({
      readyForLive,
      gateway: "HARAKAPAY",
      checks,
      balance,
      floatWarning: floatEmpty
        ? "HarakaPay wallet and float are both 0 — top up your HarakaPay balance or collects may not settle."
        : null,
      delivery: {
        stuckPending,
        deliveryWarning,
        lastSuccessfulPaymentAt: lastSettled?.updatedAt ?? null,
        lastSuccessfulPaymentAmount: lastSettled?.amount ?? null,
        underInvestigation,
        investigationWarning:
          !sandbox && underInvestigation > 0
            ? `${underInvestigation} charge(s) were approved on the customer's phone but never settled. ` +
              "These customers have been told not to pay again — resolve each one in Admin → Payments → Being checked. " +
              "If this is a new merchant account, suspect an unfunded float."
            : null,
      },
      // Gateways charge a per-transaction fee; the 70/30 split is computed on the
      // gross amount, so the platform's real margin is platformFee − gateway fee.
      gatewayFeeNotice:
        balance.ok && balance.float_balance !== undefined
          ? "HarakaPay deducts a transaction fee (e.g. TZS 59 on TZS 1,000). The 70/30 split uses the gross amount, so the platform keeps its 30% minus that fee."
          : null,
      // The local circuit breaker. When it is open, gateway calls are being
      // *skipped*, which reads as a failed balance check unless it is named — the
      // operator would be sent hunting for a bad key that is actually fine.
      gatewayBreaker: {
        open: breaker.open,
        openUntil: breaker.open ? new Date(breaker.openUntil).toISOString() : null,
        failures: breaker.failures,
        skipped: breaker.skipped,
        warning: breakerWarning,
      },
      // The breaker leads when it is open: every other line below is about a
      // gateway the operator cannot currently reach, and reading them first
      // sends somebody after the wrong fault.
      summary: breakerWarning
        ? breakerWarning
        : readyForLive
          ? deliveryWarning
            ? "Live payments are on, but recent orders never settled — see delivery.deliveryWarning."
            : floatEmpty
              ? "Live payments are on, but the HarakaPay float is empty — top it up before going live."
              : "Live payments are ready: a purchase will send a real USSD push to the customer's phone."
          : sandbox
            ? "Sandbox is ON: no USSD push is sent and no money moves. Set PAYMENT_SANDBOX=false to go live."
            : "Live mode is on but one or more checks failed — see checks/balance above.",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Payment Health Error]", error);
    return api.internal();
  }
}
