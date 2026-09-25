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
  floatGate,
  floatGateApplies,
  FLOAT_EMPTY_CUSTOMER_MESSAGE,
  FLOAT_CACHE_MS,
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

    // The GATE, which is a different question from the balance above: the
    // balance is a fresh reading for the operator to look at, while the gate is
    // the decision every checkout is actually judged by — and it answers from a
    // reading up to a minute old, because that is what stops one customer a
    // minute from costing one balance call each. So the two can disagree for a
    // moment, and when they do, this is the one that decides whether money is
    // asked for. `unknown` is reported as itself: a balance we could not read is
    // not evidence the float is empty, and the gate sells in that state.
    let gate: { state: "ok" | "empty" | "unknown"; floatTzs: number | null; cached: boolean } = {
      state: "ok",
      floatTzs: null,
      cached: false,
    };
    if (floatGateApplies()) {
      const read = await floatGate();
      gate = { state: read.state, floatTzs: read.floatTzs, cached: read.cached };
    }

    const gateRefusing = gate.state === "empty";
    const gateBlind = gate.state === "unknown";
    const floatGateWarning = gateRefusing
      ? "The float gate is REFUSING USSD collects: the merchant float that pays for " +
        "prompts is empty, so a charge accepted now would never reach a phone. Checkout " +
        "answers 503 (GATEWAY_FLOAT_EMPTY) with a clear message instead of accepting an " +
        `order that cannot settle. Top up the HarakaPay float — sales resume by themselves ` +
        `within ${Math.round(FLOAT_CACHE_MS / 1000)}s of the reading changing, with nothing to restart.`
      : gateBlind
        ? "The float could not be read, so collects are being attempted anyway (fail open). " +
          "An unreadable balance is not proof that the float is empty, and refusing sales that " +
          "would have worked is a worse error than a collect the gateway rejects."
        : null;

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
    // The same gate as a check row, so the System readiness tab shows it next to
    // the API key and the balance without the panel needing a new field to
    // understand: `ok: false` here is "checkout is refusing sales right now".
    const checksWithGate = {
      ...checks,
      floatGate: {
        ok: !gateRefusing,
        value: `${gate.state}${gate.floatTzs !== null ? ` · float TZS ${gate.floatTzs}` : ""}` +
          `${gate.cached ? " · cached" : ""}`,
        hint: gateRefusing
          ? "Collects are being refused before the gateway is called, because a USSD prompt would never be delivered"
          : gateBlind
            ? "The float could not be read; collects are attempted and the gateway's own answer decides"
            : "The float has something in it, so a USSD prompt can be delivered",
      },
    };

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
      checks: checksWithGate,
      balance,
      // The refusal itself: which state the gate is in, what the customer is
      // being told, and the one thing an operator has to do about it. Shown as
      // its own block because it is a decision this app makes, not a reading it
      // took — the balance above can be perfectly fine while a cached gate is
      // still refusing, and only one of the two is an action item.
      floatGate: {
        state: gate.state,
        floatTzs: gate.floatTzs,
        cached: gate.cached,
        refusing: gateRefusing,
        /** Exactly the words checkout returns, so support reads what the fan read. */
        customerMessage: gateRefusing ? FLOAT_EMPTY_CUSTOMER_MESSAGE : null,
        warning: floatGateWarning,
      },
      // Suppressed while the gate is refusing, because the block above already
      // says it with the consequence attached; two lines describing one empty
      // float is how a real warning gets skimmed past.
      floatWarning: floatEmpty && !gateRefusing
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
      // The gate leads when it is refusing, and the breaker leads before it:
      // both are reasons a customer could not pay just now, and every line below
      // is about money that never moved because of one of them.
      summary: breakerWarning
        ? breakerWarning
        : gateRefusing
          ? "Payments are PAUSED: the HarakaPay float is empty and the gate is refusing " +
            "USSD collects (503 GATEWAY_FLOAT_EMPTY). Customers see a clear message and are " +
            "not charged. Top up the float and sales resume on their own."
          : readyForLive
            ? deliveryWarning
              ? "Live payments are on, but recent orders never settled — see delivery.deliveryWarning."
              : floatEmpty
                ? "Live payments are on, but the HarakaPay float is empty — top it up before going live."
                : gateBlind
                  ? "Live payments are ready, but the float could not be read — collects are being attempted (fail open); see floatGate."
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
