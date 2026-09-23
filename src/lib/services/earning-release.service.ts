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
    select: { creatorId: true, pendingBalance: true, releasedTotal: true },
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
    }
  }

  return { released, creators };
}
