// =============================================================================
// GENHUB - Earning Release Service
// Moves creator earnings out of the 14-day holding period:
//   pendingBalance -> availableBalance once the source transaction is old enough.
//
// Invariants:
//   * Every creator-crediting transaction (PPV_PURCHASE / TIP / SUBSCRIPTION)
//     sets `creatorCut` AND credits `pendingBalance` with exactly that amount,
//     so SUM(creatorCut, SUCCESS, older than holding) is the total ever matured.
//   * `releasedTotal` tracks the cumulative amount ever released, so the next
//     release is simply `matured - releasedTotal` (payout requests touch
//     availableBalance and cannot cause a double release).
//   * Idempotent + safe to run concurrently (optimistic lock on releasedTotal).
// =============================================================================

import prisma from "../db";
import config from "../config";

export interface ReleaseResult {
  /** Total TZS moved from pending to available in this run */
  released: number;
  /** Number of creators whose balance changed */
  creators: number;
}

export async function releaseMatureEarnings(
  creatorId?: string
): Promise<ReleaseResult> {
  const holdingMs = config.business.holdingPeriodDays * 86_400_000;
  const cutoff = new Date(Date.now() - holdingMs);

  const balances = await prisma.creatorBalance.findMany({
    where: creatorId ? { creatorId } : {},
    select: {
      creatorId: true,
      pendingBalance: true,
      availableBalance: true,
      releasedTotal: true,
    },
  });

  let released = 0;
  let creators = 0;

  for (const balance of balances) {
    if (balance.pendingBalance <= 0) continue;

    // Total creator earnings whose holding period has elapsed
    const matured = await prisma.transaction.aggregate({
      where: {
        creatorId: balance.creatorId,
        status: "SUCCESS",
        creatorCut: { not: null },
        createdAt: { lte: cutoff },
      },
      _sum: { creatorCut: true },
    });
    const maturedTotal = matured._sum.creatorCut ?? 0;

    const delta = maturedTotal - balance.releasedTotal;
    if (delta <= 0) continue;

    // Never release more than what is currently held
    const amount = Math.min(delta, balance.pendingBalance);
    if (amount <= 0) continue;

    // Optimistic lock: only apply if releasedTotal/pendingBalance are unchanged,
    // so two concurrent runs can never release the same earnings twice.
    const { count } = await prisma.creatorBalance.updateMany({
      where: {
        creatorId: balance.creatorId,
        releasedTotal: balance.releasedTotal,
        pendingBalance: { gte: amount },
      },
      data: {
        pendingBalance: { decrement: amount },
        availableBalance: { increment: amount },
        releasedTotal: { increment: amount },
      },
    });

    if (count > 0) {
      released += amount;
      creators += 1;

      // Tell the creator the money is now theirs to withdraw. This is the moment
      // the 14-day rule stops being abstract — without it the creator only sees
      // pending sit still and assumes the platform is keeping it. Best effort:
      // a notification must never undo a release that already happened.
      try {
        await prisma.notification.create({
          data: {
            userId: balance.creatorId,
            title: "Earnings released 💰",
            message:
              `TZS ${amount.toLocaleString("en-US")} finished its ` +
              `${config.business.holdingPeriodDays}-day holding period and is now ` +
              `available to withdraw.`,
            type: "success",
            link: "/creator",
          },
        });
      } catch (notifyError) {
        console.error(
          "[Earning Release] Notification failed:",
          (notifyError as Error)?.message
        );
      }

      // A creator whose withdrawable balance just crossed the floor can now
      // actually take money out. Firing on the CROSSING (below before, at or
      // above after) rather than on "is above the minimum" is what keeps this
      // from nagging on every release — and it fires again only if a payout
      // drops them back below and they earn past it once more.
      const minPayout = config.business.minPayoutAmount;
      if (
        balance.availableBalance < minPayout &&
        balance.availableBalance + amount >= minPayout
      ) {
        try {
          await prisma.notification.create({
            data: {
              userId: balance.creatorId,
              title: "You can withdraw now 💸",
              message:
                `Your available balance reached TZS ${minPayout.toLocaleString("en-US")}. ` +
                "You can request a withdrawal to M-Pesa, Tigo Pesa, Airtel Money or your bank.",
              type: "success",
              link: "/creator",
            },
          });
        } catch (nudgeError) {
          console.error(
            "[Earning Release] Withdrawal nudge failed:",
            (nudgeError as Error)?.message
          );
        }
      }
    }
  }

  return { released, creators };
}
