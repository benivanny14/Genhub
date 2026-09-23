// =============================================================================
// GENHUB - Payment reconciliation
//
// A USSD push can end in four ways, and only ONE of them produces a webhook:
//
//   1. the customer approves it        -> webhook, or this job finds `completed`
//   2. the customer declines/ignores it -> gateway reports `failed`/`cancelled`
//   3. the gateway never delivers it    -> stays `processing` forever (unfunded
//                                          or not-yet-activated merchant account)
//   4. the customer approves it but the gateway never settles it — `processing`
//      forever WHILE THE MONEY LEFT THE HANDSET (bank/settlement fault)
//
// Cases 3 and 4 look identical from here, and that is the whole problem: in
// case 4 the customer has paid and we would be telling them "payment failed,
// try again" — which is how the same purchase gets charged twice.
//
// So this job asks the gateway directly, then:
//   * settles anything the gateway has completed or failed (cases 1 and 2)
//   * moves anything past the hard TTL that the gateway still calls `processing`
//     to UNDER_INVESTIGATION, and tells the customer to NOT pay again until we
//     have checked with the network
//   * KEEPS ASKING about charges already under investigation
//
// That last point matters more than it looks. The usual reason a charge never
// settled is that the webhook never reached us — which is the same broken
// delivery path that would have resolved it automatically. If investigating rows
// were only re-checked by hand, a payment that settled five minutes after being
// flagged would stay unresolved until an admin happened to look, and the customer
// would be left waiting on a purchase that had already gone through.
//
// Neither step discards money: processPaymentWebhook still honours a settlement
// that arrives after either transition.
// =============================================================================

import prisma from "../db";
import config from "../config";
import {
  harakaStatus,
  harakaStatusToInternal,
  harakaErrorReason,
} from "../payments/harakapay";
import { processPaymentWebhook } from "./webhook.service";
import { notifyPaymentResult } from "./payment-notify.service";

// Give up waiting on a prompt this long after checkout.
export const HARD_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ReconcileResult {
  checked: number;
  settledSuccess: number;
  settledFailed: number;
  /** Newly flagged this run: never settled, still `processing` past the TTL. */
  underInvestigation: number;
  /** Still inside the TTL, or the gateway is actively progressing them. */
  stillProcessing: number;
  /** Already flagged, and the gateway still has no verdict after asking again. */
  awaitingResolution: number;
  errors: number;
}

export async function reconcileStalePayments(options?: {
  olderThanMinutes?: number;
  limit?: number;
  /** Scope to one customer (support tooling and tests). */
  userId?: string;
}): Promise<ReconcileResult> {
  const olderThanMinutes = options?.olderThanMinutes ?? 10;
  const limit = options?.limit ?? 100;
  const userId = options?.userId;

  const result: ReconcileResult = {
    checked: 0,
    settledSuccess: 0,
    settledFailed: 0,
    underInvestigation: 0,
    stillProcessing: 0,
    awaitingResolution: 0,
    errors: 0,
  };

  // Nothing to reconcile when the gateway is never contacted.
  if (!config.harakaPay.apiKey || config.harakaPay.sandbox) return result;

  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const hardCutoff = new Date(Date.now() - HARD_TTL_MS);

  const pending = await prisma.transaction.findMany({
    where: {
      // UNDER_INVESTIGATION rows are included on purpose: they are the charges
      // most likely to have settled without us hearing about it (that missing
      // webhook is why they got stuck), so they need asking about most of all.
      status: { in: ["PENDING", "UNDER_INVESTIGATION"] },
      gateway: "HARAKAPAY",
      providerRef: { not: null },
      createdAt: { lt: cutoff },
      ...(userId ? { userId } : {}),
    },
    select: {
      id: true,
      userId: true,
      amount: true,
      status: true,
      providerRef: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const tx of pending) {
    result.checked += 1;

    try {
      const remote = await harakaStatus(tx.providerRef!);
      const internal = remote.payment
        ? harakaStatusToInternal(remote.payment.status)
        : null;

      if (internal) {
        await processPaymentWebhook({
          orderId: tx.id,
          transactionId: tx.providerRef!,
          amount: tx.amount,
          status: internal,
          provider: "HARAKAPAY",
          metadata: { reconciled: "sweeper" },
        });
        if (internal === "SUCCESS") result.settledSuccess += 1;
        else result.settledFailed += 1;
        continue;
      }

      // Already flagged and still no verdict — we asked again, which is all we
      // can do. Do not re-notify: the customer already knows.
      if (tx.status === "UNDER_INVESTIGATION") {
        result.awaitingResolution += 1;
        continue;
      }

      // Gateway still says "processing" past the hard TTL. A USSD session lives
      // for minutes, so this is one of two things and we CANNOT tell them apart:
      // the prompt was never answered, or it was answered and the settlement is
      // stuck. Only a human can resolve that, so the charge becomes
      // UNDER_INVESTIGATION — never FAILED, which would invite a second payment.
      //
      // Note the customer is deliberately NOT told "it failed": the message says
      // we are checking and not to pay again.
      if (tx.createdAt < hardCutoff) {
        await prisma.transaction.update({
          where: { id: tx.id, status: "PENDING" },
          data: {
            status: "UNDER_INVESTIGATION",
            metadata: {
              investigation: true,
              reason: "gateway_never_settled",
              gatewayStatus: remote.payment?.status ?? "processing",
              reconciledAt: new Date().toISOString(),
            },
          },
        });
        await notifyPaymentResult({
          transactionId: tx.id,
          outcome: "UNDER_INVESTIGATION",
        });
        result.underInvestigation += 1;
      } else {
        result.stillProcessing += 1;
      }
    } catch (error) {
      result.errors += 1;
      console.warn(
        `[Reconcile] Failed for ${tx.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return result;
}

// =============================================================================
// Force-expire ONE charge (support tooling / admin panel)
// Same soft-expire semantics as the sweeper: the row becomes FAILED with
// metadata.expired, so a late settlement is still honoured by
// processPaymentWebhook and the customer's checkout lock is released.
// =============================================================================

export type ExpireChargeResult =
  | { ok: true; amount: number; userId: string }
  | { ok: false; reason: "not_found" | "not_pending"; status?: string };

/** Statuses an admin can still release: nothing final has happened yet. */
const RELEASABLE: Array<"PENDING" | "UNDER_INVESTIGATION"> = [
  "PENDING",
  "UNDER_INVESTIGATION",
];

export async function expirePaymentCharge(params: {
  transactionId: string;
  reason?: string;
  /** Admin id that triggered it, recorded in metadata for the audit trail. */
  actorId?: string;
}): Promise<ExpireChargeResult> {
  const { transactionId, reason = "admin_force_expire", actorId } = params;

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, amount: true, userId: true },
  });

  if (!transaction) return { ok: false, reason: "not_found" };
  if (!RELEASABLE.includes(transaction.status as "PENDING")) {
    return { ok: false, reason: "not_pending", status: transaction.status };
  }

  // Conditional update: if a webhook settled it between the read and the write,
  // the where clause no longer matches and nothing changes. This is also how an
  // investigation is released — `expired: true` keeps a settlement that arrives
  // afterwards valid, so releasing never destroys a real payment.
  const updated = await prisma.transaction.updateMany({
    where: { id: transactionId, status: transaction.status as "PENDING" },
    data: {
      status: "FAILED",
      metadata: {
        expired: true,
        investigation: false,
        reason,
        reconciledAt: new Date().toISOString(),
        ...(actorId ? { expiredBy: actorId } : {}),
      },
    },
  });

  if (updated.count === 0) {
    return { ok: false, reason: "not_pending", status: "SUCCESS" };
  }

  await notifyPaymentResult({
    transactionId,
    outcome: "FAILED",
    reason: "expired",
  });

  return { ok: true, amount: transaction.amount, userId: transaction.userId };
}

// =============================================================================
// Ask the gateway again, right now
// =============================================================================
// Used by the admin reconciliation view. Deliberately cannot downgrade an
// investigation: a gateway that says "failed" settles it, but a gateway that
// still says "processing" leaves it exactly where it is.

export type RecheckResult =
  | {
      ok: true;
      status: string;
      gatewayStatus: string | null;
      settled: boolean;
      /**
       * Set when the gateway could not be asked at all (unknown order, bad key,
       * timeout). The charge is left exactly as it was — an unreachable gateway
       * is not evidence that the money never moved.
       */
      gatewayError?: string;
    }
  | { ok: false; reason: "not_found" | "no_provider_ref" | "final" };

export async function recheckPaymentCharge(
  transactionId: string
): Promise<RecheckResult> {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, amount: true, providerRef: true },
  });
  if (!tx) return { ok: false, reason: "not_found" };
  if (!tx.providerRef) return { ok: false, reason: "no_provider_ref" };
  if (tx.status === "SUCCESS" || tx.status === "FAILED") {
    return { ok: false, reason: "final" };
  }

  // Nothing to ask when the gateway is not reachable/in use.
  if (!config.harakaPay.apiKey || config.harakaPay.sandbox) {
    return { ok: true, status: tx.status, gatewayStatus: null, settled: false };
  }

  let remote: Awaited<ReturnType<typeof harakaStatus>>;
  try {
    remote = await harakaStatus(tx.providerRef);
  } catch (error) {
    // Most often: HarakaPay has never heard of this order id. Report it instead
    // of throwing, because "we could not ask" must not be mistaken for an answer
    // — the charge stays under investigation, which is the safe reading.
    return {
      ok: true,
      status: tx.status,
      gatewayStatus: null,
      settled: false,
      gatewayError: harakaErrorReason(error),
    };
  }

  const gatewayStatus = remote.payment?.status ?? null;
  const internal = remote.payment
    ? harakaStatusToInternal(remote.payment.status)
    : null;

  if (!internal) {
    return {
      ok: true,
      status: tx.status,
      gatewayStatus,
      settled: false,
    };
  }

  await processPaymentWebhook({
    orderId: tx.id,
    transactionId: tx.providerRef,
    amount: tx.amount,
    status: internal,
    provider: "HARAKAPAY",
    metadata: { reconciled: "admin-recheck" },
  });

  return { ok: true, status: internal, gatewayStatus, settled: true };
}

// =============================================================================
// Resolve ONE under-investigation charge
// =============================================================================
// A charge we could neither confirm nor deny needs a human decision:
//
//   GRANT       the customer did pay (the operator confirmed it). Access is
//               granted through the normal settlement path, so the money is
//               split 70/30 exactly like a webhook.
//   MARK_UNPAID the money never moved. The charge is released AND marked
//               expired, so a settlement that still arrives later is honoured —
//               an "it didn't go through" decision must never lose money.

export type InvestigationOutcome = "GRANT" | "MARK_UNPAID";

export type ResolveInvestigationResult =
  | { ok: true; outcome: InvestigationOutcome; amount: number; userId: string }
  | { ok: false; reason: "not_found" | "not_under_investigation"; status?: string };

export async function resolveInvestigation(params: {
  transactionId: string;
  outcome: InvestigationOutcome;
  actorId?: string;
  note?: string;
}): Promise<ResolveInvestigationResult> {
  const { transactionId, outcome, actorId, note } = params;

  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, amount: true, userId: true, providerRef: true },
  });

  if (!tx) return { ok: false, reason: "not_found" };
  if (tx.status !== "UNDER_INVESTIGATION") {
    return { ok: false, reason: "not_under_investigation", status: tx.status };
  }

  if (outcome === "GRANT") {
    // Same single settlement path as a webhook: PPV access, wallet credit or
    // subscription activation, plus the 70/30 split and the customer notice.
    await processPaymentWebhook({
      orderId: tx.id,
      transactionId: tx.providerRef || `ADMIN-GRANT-${tx.id}`,
      amount: tx.amount,
      status: "SUCCESS",
      provider: "HARAKAPAY",
      metadata: { resolution: "granted", resolvedBy: actorId, note },
    });
    return { ok: true, outcome, amount: tx.amount, userId: tx.userId };
  }

  await prisma.transaction.updateMany({
    where: { id: tx.id, status: "UNDER_INVESTIGATION" },
    data: {
      status: "FAILED",
      metadata: {
        expired: true,
        investigation: false,
        resolution: "not_paid",
        resolvedBy: actorId,
        resolvedAt: new Date().toISOString(),
        ...(note ? { note } : {}),
      },
    },
  });

  await notifyPaymentResult({
    transactionId: tx.id,
    outcome: "FAILED",
    reason: "resolved_not_paid",
  });

  return { ok: true, outcome, amount: tx.amount, userId: tx.userId };
}

// The admin reconciliation queue itself is served by GET /api/admin/payments
// (?status=UNDER_INVESTIGATION) plus summary.investigating — the page needs
// pagination, the shared row shape and the stuck counts together, so a second
// query builder here would only be able to drift from it.
