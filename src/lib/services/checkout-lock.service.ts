// =============================================================================
// GENHUB - One live checkout per customer
//
// A USSD push is approved in a minute or two, so a PENDING row is a lock: it
// stops the same customer starting a second checkout for the same thing while
// the first prompt is still on their phone. Without it, two prompts could both
// be approved and both settle.
//
// The lock has to expire, though, and that is the whole reason this file exists.
// The common outcome of a prompt is that nobody approves it — the customer puts
// the phone down, or the merchant float is empty and the prompt never arrives —
// and the row then sits PENDING forever. A lock that never lifts is not a
// protection, it is a customer who can never buy the thing again, and the
// purchase route learned this first: after the TTL it asks the gateway once
// (the money may have moved while the webhook was lost), then releases the lock.
//
// The subscription route had only the first half. It refused a second checkout
// while one was "still pending" and told the customer "Earlier attempts were
// cancelled" — while cancelling nothing, so a single stuck subscription blocked
// that viewer from subscribing to that creator forever. One helper, used by
// both, so the two cannot drift: the rule about when a lock lifts is money
// handling and belongs in exactly one place.
// =============================================================================

import prisma from "@/lib/db";
import config from "@/lib/config";
import { clickpesaStatus, clickpesaStatusToInternal } from "@/lib/payments/clickpesa";
import { processPaymentWebhook } from "./webhook.service";
import { notifyPaymentResult } from "./payment-notify.service";

/**
 * How long an unpaid checkout keeps the purchase locked.
 *
 * A USSD prompt is usually answered in a minute or two; after this window we
 * reconcile with the gateway, then release the lock so they can try again.
 */
export const CHECKOUT_TTL_MS = 10 * 60 * 1000;

/** The minimal shape of a pending row this helper needs. */
export interface PendingCheckout {
  id: string;
  amount: number;
  providerRef: string | null;
  createdAt: Date;
}

export type PendingCheckoutOutcome =
  /** Younger than the TTL: the first prompt may still be live, keep the lock. */
  | { state: "fresh"; minutesLeft: number }
  /** The gateway had in fact settled it SUCCESS — access was just granted. */
  | { state: "paid" }
  /** Released (or already settled FAILED): the customer may start again. */
  | { state: "released" };

/**
 * Decide what a still-PENDING checkout means, and act on it.
 *
 * Fresh rows are left alone. Stale rows are reconciled with the gateway first,
 * because the usual reason a row is still PENDING is that the webhook that would
 * have settled it never arrived — releasing the lock without asking would be the
 * one way to lose a payment that already went through. Only when the gateway has
 * no verdict (still `processing`, or unreachable) is the lock released, and it is
 * released as `FAILED` with `metadata.expired`, so `processPaymentWebhook` still
 * honours a settlement that arrives after the fact.
 */
export async function resolvePendingCheckout(
  pending: PendingCheckout
): Promise<PendingCheckoutOutcome> {
  const ageMs = Date.now() - pending.createdAt.getTime();

  if (ageMs < CHECKOUT_TTL_MS) {
    return {
      state: "fresh",
      minutesLeft: Math.ceil((CHECKOUT_TTL_MS - ageMs) / 60_000),
    };
  }

  // Ask the gateway before releasing — the money may have moved while the
  // webhook was lost. Skipped in sandbox / when the gateway is not in use.
  if (pending.providerRef && config.clickPesa.apiKey && !config.clickPesa.sandbox) {
    try {
      const remote = await clickpesaStatus(pending.providerRef);
      const internal = remote.payment
        ? clickpesaStatusToInternal(remote.payment.status)
        : null;

      if (internal) {
        // Finalises the row either way (SUCCESS grants access/plan, FAILED clears it).
        await processPaymentWebhook({
          orderId: pending.id,
          transactionId: pending.providerRef,
          amount: pending.amount,
          status: internal,
          provider: "CLICKPESA",
          metadata: { reconciled: "stale-pending" },
        });
        if (internal === "SUCCESS") return { state: "paid" };
        // FAILED was settled (and the customer told) by the processor.
        return { state: "released" };
      }
    } catch (error) {
      // Non-fatal: the webhook or a later sweep can still settle it. Release the
      // lock anyway — a gateway that will not answer is not evidence the money
      // never moved, and the expired flag keeps a late settlement valid.
      console.warn(
        "[Checkout] Stale-pending reconcile failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  // Conditional update, so a settlement that lands between the read and the write
  // is not clobbered: if the row already moved on, nothing changes and nobody is
  // told the wrong thing.
  const released = await prisma.transaction.updateMany({
    where: { id: pending.id, status: "PENDING" },
    data: { status: "FAILED", metadata: { expired: true } },
  });

  if (released.count > 0) {
    await notifyPaymentResult({
      transactionId: pending.id,
      outcome: "FAILED",
      reason: "expired",
    });
  }

  return { state: "released" };
}
