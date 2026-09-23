// =============================================================================
// GENHUB - Reversing a charge that turned out to have been collected
//
// An UNDER_INVESTIGATION charge is one whose USSD prompt was approved but never
// settled. Two things can be true, and the admin's job is to find out which:
//
//   * the customer paid and wants what they bought  -> grant (payments route)
//   * the customer paid and cannot get it           -> REVERSE, i.e. this file
//
// The second case is the hard one, because "refund" is two separate movements of
// money that must not be confused with each other:
//
//   1. RETURNING VALUE TO THE CUSTOMER
//   2. TAKING BACK THE CREATOR'S 70%
//
// -----------------------------------------------------------------------------
// THERE IS NO HARAKAPAY REVERSAL API
// -----------------------------------------------------------------------------
// Its entire API surface is POST /api/v1/collect, GET /api/v1/status/{id} and
// GET /api/v1/balance. Probing every plausible reversal path (/reverse,
// /reversal, /refund, /refunds, /refund/{id}, /reverse/{id}, /payout,
// /disburse, /withdraw, /cancel) returns the same Express HTML 404 as a
// deliberately fake route, while POST /api/v1/collect answers with a real
// business error — so those routes genuinely do not exist.
//
// That matters because it means the network leg CANNOT be automated, and
// pretending otherwise would produce the worst possible outcome: a "refunded"
// record for money that never went back. So this service is explicit about
// which leg it moved:
//
//   destination = WALLET   we move it ourselves, atomically, right now. The
//                          customer gets spendable balance immediately. We never
//                          ask the network to send anything back, so there is no
//                          way to pay them twice.
//
//   destination = GATEWAY  the operator reversed it in the HarakaPay dashboard
//                          and records the reference here. We only write down
//                          what they told us — we cannot verify it, so the
//                          reference is REQUIRED and the customer is told to
//                          expect the money on their phone rather than in their
//                          wallet.
//
// -----------------------------------------------------------------------------
// TAKING THE MONEY BACK FROM THE CREATOR
// -----------------------------------------------------------------------------
// Only a charge that SETTLED in our books has anything to claw back. A charge
// still under investigation never went through settlement, so the creator was
// never credited, `creatorCut` is null, and no videoEarning row exists. Clawing
// back there would take money the creator never received — so the creator's leg
// is skipped entirely for those, and the reversal is a support cost we chose.
//
// When it does apply, the 70% comes out of `pendingBalance` first, then
// `availableBalance`. It never goes negative — a creator whose payout already
// left the building cannot be un-paid by this system, and a negative balance
// would silently break the release job. Whatever could not be recovered is
// recorded as `shortfall` on the transaction for the books.
//
// Recovery then happens by itself, without any debt ledger: the 14-day release
// job computes matured earnings as SUM(creatorCut) WHERE status = 'SUCCESS', so
// a REFUNDED row simply drops out of that sum. If the creator had already been
// paid out, `releasedTotal` now exceeds what is genuinely matured and the job
// stops releasing until new sales cover the difference. The books balance; the
// creator's future earnings repay the reversal.
// =============================================================================

import prisma from "../db";
import { resyncSubscriberCount } from "./subscription.service";
import { debitWallet } from "./balance.service";

/** Where the customer's money actually goes back to. */
export type RefundDestination = "WALLET" | "GATEWAY";

/** What the customer stops having as a result of the reversal. */
export type RevokedGoods =
  | "VIDEO_ACCESS"
  | "MEMBERSHIP"
  | "TOPUP_CREDIT"
  | "NOTHING";

export interface ReverseChargeParams {
  transactionId: string;
  destination: RefundDestination;
  /** Admin id, recorded for the audit trail. */
  actorId: string;
  /** Why it is being reversed (shown to the customer and the creator). */
  reason?: string;
  /**
   * The reversal reference from the HarakaPay dashboard. Required for
   * destination GATEWAY, since that is the only evidence the network leg
   * happened at all.
   */
  gatewayRef?: string;
}

export type ReverseChargeResult =
  | {
      ok: true;
      amount: number;
      destination: RefundDestination;
      /**
       * True when the charge had settled before this reversal, i.e. the creator
       * really was credited and the 70% clawback applied. False when the charge
       * was still under investigation, in which case the creator's leg is a
       * no-op and nothing was taken from them.
       */
      settledBefore: boolean;
      /** Credited to the customer's wallet (0 for a gateway reversal). */
      walletCredited: number;
      /** Debited from the customer's wallet (wallet top-up reversals only). */
      walletDebited: number;
      /** Clawed back out of the creator's pending / available balances. */
      clawedBackPending: number;
      clawedBackAvailable: number;
      /** Creator money that had already been paid out and cannot be recovered. */
      shortfall: number;
      /** What stopped being available to the customer as a result. */
      revoked: RevokedGoods;
      userId: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_reversible"
        | "already_refunded"
        | "gateway_ref_required"
        | "wallet_refund_of_topup"
        | "insufficient_wallet";
      status?: string;
      detail?: string;
    };

/** Statuses money can be returned from: we must actually hold it. */
const REVERSIBLE: Array<"UNDER_INVESTIGATION" | "SUCCESS"> = [
  "UNDER_INVESTIGATION",
  "SUCCESS",
];

export async function reverseCollectedCharge(
  params: ReverseChargeParams
): Promise<ReverseChargeResult> {
  const { transactionId, destination, actorId, reason, gatewayRef } = params;

  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      userId: true,
      creatorId: true,
      videoId: true,
      amount: true,
      creatorCut: true,
      type: true,
      status: true,
      gateway: true,
      providerRef: true,
      metadata: true,
    },
  });

  if (!tx) return { ok: false, reason: "not_found" };

  // Refunding twice is the one mistake that turns a fix into a leak.
  if (tx.status === "REFUNDED") {
    return { ok: false, reason: "already_refunded", status: tx.status };
  }

  // A PENDING charge may never have collected anything, so there is nothing to
  // give back yet; a FAILED one never collected. Only money we HOLD is
  // reversible — which is exactly the two states below.
  if (!REVERSIBLE.includes(tx.status as "UNDER_INVESTIGATION" | "SUCCESS")) {
    return { ok: false, reason: "not_reversible", status: tx.status };
  }

  // The gateway leg cannot be automated, so it must be evidenced.
  if (destination === "GATEWAY" && !gatewayRef?.trim()) {
    return { ok: false, reason: "gateway_ref_required" };
  }

  // A top-up is ALREADY wallet credit. Refunding it "to the wallet" would credit
  // the same money a second time, which is a straight loss. Returning a top-up
  // means taking the credit back out and sending it to the customer's phone.
  if (tx.type === "WALLET_TOPUP" && destination === "WALLET") {
    return { ok: false, reason: "wallet_refund_of_topup" };
  }

  const isTopUp = tx.type === "WALLET_TOPUP";

  // Did this charge ever actually settle? Only then were the creator's balance,
  // `videoEarning` and `purchaseCount` moved, and only then can they be reversed.
  const wasSettled = tx.status === "SUCCESS";

  // The creator's share of THIS charge. For a tip the creator keeps 100%, which
  // is why this reads creatorCut and only falls back to the amount.
  const creatorShare = isTopUp || !wasSettled ? 0 : tx.creatorCut ?? tx.amount;

  // What the customer must pay back when we reverse a top-up they already hold.
  // Wallet top-ups are credited at the full amount.
  const walletTopUpCredit = isTopUp ? tx.amount : 0;

  try {
    const outcome = await prisma.$transaction(async (db) => {
      // ---------------------------------------------------------------- guards
      // Re-read inside the transaction: an admin could have granted or expired
      // this charge between the check above and now.
      const current = await db.transaction.findUnique({
        where: { id: tx.id },
        select: { status: true },
      });
      if (!current || current.status !== tx.status) {
        return { conflict: true as const };
      }

      // The "does the customer still hold this credit?" check is the debit
      // itself, further down — see the top-up leg. A read here could only
      // describe the moment before a second refund, a video purchase or a tip
      // spent the same credit.

      // ------------------------------------------------- 1. the customer's leg
      let walletCredited = 0;
      let walletDebited = 0;
      let revoked: RevokedGoods = "NOTHING";

      if (isTopUp) {
        // Take the credit back, then (for GATEWAY) it is returned to the phone.
        // Conditional (debitWallet): if the customer has already spent it, the
        // debit moves nothing and the reversal stops here rather than paying out
        // money we no longer hold.
        const taken = await debitWallet(db, { userId: tx.userId, amount: walletTopUpCredit });
        if (!taken.ok) {
          return { insufficient: true as const, balance: taken.balance };
        }
        walletDebited = walletTopUpCredit;
        revoked = "TOPUP_CREDIT";
      } else if (destination === "WALLET") {
        await db.user.update({
          where: { id: tx.userId },
          data: { walletBalance: { increment: tx.amount } },
        });
        walletCredited = tx.amount;
      }

      // -------------------------------------------------- 2. revoke the goods
      // Refunding means the customer does not keep what the money bought.
      if (tx.type === "PPV_PURCHASE" && tx.videoId) {
        // Only revoke if this charge is the reason they have access — a customer
        // who bought the video twice must not lose it for the surviving charge.
        const otherPaid = await db.transaction.findFirst({
          where: {
            id: { not: tx.id },
            userId: tx.userId,
            videoId: tx.videoId,
            type: "PPV_PURCHASE",
            status: "SUCCESS",
          },
          select: { id: true },
        });

        if (!otherPaid) {
          // `revoked` has to describe what actually changed: an investigation
          // never granted access, so there is usually nothing to take back and
          // reporting VIDEO_ACCESS would be a lie in the audit trail.
          const removed = await db.videoAccess.deleteMany({
            where: { viewerId: tx.userId, videoId: tx.videoId },
          });
          if (removed.count > 0) revoked = "VIDEO_ACCESS";
        }
      } else if (tx.type === "SUBSCRIPTION" && tx.creatorId) {
        const ended = await db.creatorSubscription.updateMany({
          where: { viewerId: tx.userId, creatorId: tx.creatorId, isActive: true },
          // autoRenew off too, so the renewal cron cannot charge for a
          // membership we just refunded.
          data: { isActive: false, autoRenew: false },
        });
        if (ended.count > 0) revoked = "MEMBERSHIP";
      }

      // ------------------------------------------------- 3. the creator's leg
      let clawedBackPending = 0;
      let clawedBackAvailable = 0;
      let shortfall = 0;

      if (creatorShare > 0 && tx.creatorId) {
        const balance = await db.creatorBalance.findUnique({
          where: { creatorId: tx.creatorId },
          select: { pendingBalance: true, availableBalance: true, totalEarned: true },
        });

        if (balance) {
          // Pending first: that is money we have not paid out, so it is the
          // safest to take back. Then whatever has already matured.
          //
          // How much is there comes from a read, and between that read and the
          // write another refund, or a release, can move the same balance —
          // sub-millisecond against a local database, wide open across a
          // network. So the write carries the same amounts as conditions, and a
          // refusal re-reads once instead of taking the balance negative. The
          // amounts the caller is told are the ones that actually moved.
          let applied = false;

          for (let attempt = 0; attempt < 2 && !applied; attempt++) {
            const held =
              attempt === 0
                ? balance
                : await db.creatorBalance.findUnique({
                    where: { creatorId: tx.creatorId },
                    select: {
                      pendingBalance: true,
                      availableBalance: true,
                      totalEarned: true,
                    },
                  });

            if (!held) {
              clawedBackPending = 0;
              clawedBackAvailable = 0;
              shortfall = creatorShare;
              break;
            }

            clawedBackPending = Math.min(creatorShare, Math.max(0, held.pendingBalance));
            const remaining = creatorShare - clawedBackPending;
            clawedBackAvailable = Math.min(remaining, Math.max(0, held.availableBalance));

            const taken = await db.creatorBalance.updateMany({
              where: {
                creatorId: tx.creatorId,
                pendingBalance: { gte: clawedBackPending },
                availableBalance: { gte: clawedBackAvailable },
              },
              data: {
                pendingBalance: { decrement: clawedBackPending },
                availableBalance: { decrement: clawedBackAvailable },
                // Lifetime earnings drop by the full share: the money was
                // returned, so the creator never earned it — including the part
                // we could not recover, which we record rather than hide.
                totalEarned: { decrement: Math.min(creatorShare, Math.max(0, held.totalEarned)) },
              },
            });

            applied = taken.count === 1;
          }

          if (!applied) {
            // Both attempts lost the race: nothing was taken, so nothing may be
            // reported as taken.
            clawedBackPending = 0;
            clawedBackAvailable = 0;
            shortfall = creatorShare;
          } else {
            shortfall = creatorShare - clawedBackPending - clawedBackAvailable;
          }
        } else {
          shortfall = creatorShare;
        }

        // Per-video counters, so the video's earnings card matches the books.
        // Only ever decremented for a charge that was actually counted — a
        // purchaseCount that never went up must not be pushed down.
        if (tx.videoId) {
          const videoEarning = await db.videoEarning.findUnique({
            where: { videoId: tx.videoId },
            select: { totalEarned: true, totalPurchases: true },
          });
          if (videoEarning) {
            await db.videoEarning.update({
              where: { videoId: tx.videoId },
              data: {
                totalEarned: {
                  decrement: Math.min(creatorShare, Math.max(0, videoEarning.totalEarned)),
                },
                totalPurchases: { decrement: Math.min(1, videoEarning.totalPurchases) },
              },
            });
          }
          await db.video.update({
            where: { id: tx.videoId },
            data: { purchaseCount: { decrement: 1 } },
          });
        }
      }

      // ------------------------------------------------------ 4. the record
      const refundedAt = new Date().toISOString();
      // Spread the existing metadata first: how this charge became odd in the
      // first place (the investigation history) is part of the audit trail and
      // must survive the reversal that closes it out.
      const previousMetadata = (tx.metadata ?? {}) as Record<string, unknown>;

      await db.transaction.update({
        where: { id: tx.id },
        data: {
          status: "REFUNDED",
          metadata: {
            ...previousMetadata,
            investigation: false,
            refunded: true,
            // Whether the charge had settled before it was reversed. This is the
            // field that explains why the creator's leg was or was not applied,
            // and it is why the customer notice can be accurate about whether
            // they lost something.
            settledBefore: wasSettled,
            refundedAt,
            refundedBy: actorId,
            refundDestination: destination,
            refundedAmount: tx.amount,
            // Only meaningful for the GATEWAY leg, and there it is the entire
            // evidence that the money went back.
            ...(gatewayRef?.trim() ? { gatewayReversalRef: gatewayRef.trim() } : {}),
            ...(reason?.trim() ? { refundReason: reason.trim() } : {}),
            clawedBackPending,
            clawedBackAvailable,
            ...(shortfall > 0 ? { refundShortfall: shortfall } : {}),
            ...(isTopUp ? { walletDebited } : { walletCredited }),
          },
        },
      });

      return {
        ok: true as const,
        amount: tx.amount,
        destination,
        settledBefore: wasSettled,
        walletCredited,
        walletDebited,
        clawedBackPending,
        clawedBackAvailable,
        shortfall,
        revoked,
        userId: tx.userId,
      };
    });

    if ("conflict" in outcome && outcome.conflict) {
      return { ok: false, reason: "not_reversible", status: "CHANGED" };
    }
    if ("insufficient" in outcome && outcome.insufficient) {
      return {
        ok: false,
        reason: "insufficient_wallet",
        detail: `the customer's wallet holds TZS ${outcome.balance.toLocaleString("en-US")}, less than the TZS ${walletTopUpCredit.toLocaleString("en-US")} credit being taken back`,
      };
    }

    await notifyReversal({
      userId: tx.userId,
      creatorId: tx.creatorId,
      amount: tx.amount,
      type: tx.type,
      destination,
      revoked: outcome.revoked,
      creatorShare,
      shortfall: outcome.shortfall,
      reason,
    });

    // The creator's public subscriber count is derived from live rows, so it
    // self-corrects once the membership above is inactive.
    if (tx.type === "SUBSCRIPTION" && tx.creatorId) {
      await resyncSubscriberCount(tx.creatorId).catch(() => 0);
    }

    return outcome;
  } catch (error) {
    console.error("[Reversal Error]", error);
    throw error;
  }
}

// =============================================================================
// Telling both sides what happened
// =============================================================================
// The customer's message has to be specific about WHERE the money is, because
// "refunded" means two different things here: spendable balance now, or money to
// expect on their phone. A vague message is how a customer opens a dispute about
// a refund that already happened.

async function notifyReversal(params: {
  userId: string;
  creatorId: string | null;
  amount: number;
  type: string;
  destination: RefundDestination;
  revoked: RevokedGoods;
  creatorShare: number;
  shortfall: number;
  reason?: string;
}): Promise<void> {
  const {
    userId,
    creatorId,
    amount,
    type,
    destination,
    revoked,
    creatorShare,
    shortfall,
    reason,
  } = params;

  const tzs = (n: number) => `TZS ${n.toLocaleString("en-US")}`;

  const label =
    type === "WALLET_TOPUP"
      ? "wallet top-up"
      : type === "SUBSCRIPTION"
        ? "membership"
        : type === "TIP"
          ? "tip"
          : "video purchase";

  try {
    const customerMessage =
      type === "WALLET_TOPUP"
        ? destination === "GATEWAY"
          ? `Your ${label} of ${tzs(amount)} has been reversed. The ${tzs(amount)} credit has been removed from your wallet and is on its way back to the number you paid from.`
          : `Your ${label} of ${tzs(amount)} has been reversed.`
        : destination === "WALLET"
          ? `Your ${label} of ${tzs(amount)} has been refunded to your wallet — it is available to spend now.` +
            (revoked === "VIDEO_ACCESS"
              ? " Access to that video has ended."
              : revoked === "MEMBERSHIP"
                ? " That membership has ended."
                : "")
          : `Your ${label} of ${tzs(amount)} has been refunded by HarakaPay. The money is being returned to the number you paid from — it can take up to 48 hours to appear on your phone, and it will not show in your wallet.`;

    await prisma.notification.create({
      data: {
        userId,
        title: "Refund processed 💸",
        message: customerMessage + (reason?.trim() ? ` (${reason.trim()})` : ""),
        type: "success",
        link: "/payments",
      },
    });
  } catch (error) {
    console.warn("[Reversal] Customer notice failed:", error);
  }

  if (!creatorId || creatorShare <= 0) return;

  try {
    await prisma.notification.create({
      data: {
        userId: creatorId,
        title: "A sale was reversed",
        message:
          `A ${label} of ${tzs(amount)} was refunded to the customer. ` +
          `Your ${tzs(creatorShare - shortfall)} share was taken back from your balance` +
          (shortfall > 0
            ? `; ${tzs(shortfall)} had already been paid out and could not be recovered, so it has been recorded as a platform loss.`
            : "."),
        type: "warning",
        link: "/creator/analytics",
      },
    });
  } catch (error) {
    console.warn("[Reversal] Creator notice failed:", error);
  }
}
