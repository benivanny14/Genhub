// =============================================================================
// GENHUB - Held-balance release
//
// Moves any balance still sitting in the legacy `pendingBalance` bucket into the
// withdrawable `availableBalance`.
//
// There IS no holding period any more: a sale is withdrawable the moment it
// settles, and every credit path writes `availableBalance` directly (see
// creditCreatorAvailable in balance.service.ts). So nothing should ever land in
// `pendingBalance` again. This job exists for the money that was credited BEFORE
// that changed, and for an operator who would rather clear an old balance today
// than wait for a clock that no longer means anything — which is exactly what
// the admin panel's "Release now" button runs.
//
// ---------------------------------------------------------------------------
// WHY IT DRAINS THE BUCKET INSTEAD OF RECOMPUTING MATURED EARNINGS
//
// The old implementation released `SUM(creatorCut) - releasedTotal`, which could
// only ever move money a transaction still backed. Every credit without a
// matching SUCCESS row — a duplicate webhook whose twin was later marked FAILED,
// an adjustment, anything written before the ledger was consistent — was
// invisible to that arithmetic and stuck forever. Measured on production:
// kayena_glazed held 2,450 with only 2,100 of sales behind it, so 350 had no
// lever anywhere that could move it.
//
// `pendingBalance` itself is the truth about what is held, so that is what moves.
// There is no way to double-pay: the statement that reads the bucket is the one
// that empties it, and it only matches a row whose value still equals what this
// run read.
//
// The name stays `releaseMatureEarnings`: it is still the same job to every
// caller (the cron worker, the admin panel, the creator dashboard), and renaming
// it would only churn call sites. What it means is in this comment.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { createNotification } from "./notify.service";

export interface ReleaseResult {
  /** Total TZS moved from the held bucket into the withdrawable balance. */
  released: number;
  /** Number of creators whose balance changed. */
  creators: number;
}

/**
 * Release everything held, for one creator or for everyone.
 *
 * Idempotent and safe to run concurrently: the update matches only a row whose
 * `pendingBalance` still equals the amount this run read, so two runs starting
 * together cannot both move the same money. The losers see count 0 and report
 * nothing — which is why the result is "how much did THIS run move", not "what
 * is held".
 */
export async function releaseMatureEarnings(
  creatorId?: string
): Promise<ReleaseResult> {
  const balances = await prisma.creatorBalance.findMany({
    where: creatorId ? { creatorId, pendingBalance: { gt: 0 } } : { pendingBalance: { gt: 0 } },
    select: {
      creatorId: true,
      pendingBalance: true,
      availableBalance: true,
    },
  });

  let released = 0;
  let creators = 0;

  for (const balance of balances) {
    const amount = balance.pendingBalance;
    if (amount <= 0) continue;

    // One statement: read the bucket, empty it, credit what is withdrawable. The
    // `pendingBalance: amount` guard is what makes a concurrent run lose cleanly
    // instead of moving the same money twice.
    const { count } = await prisma.creatorBalance.updateMany({
      where: { creatorId: balance.creatorId, pendingBalance: amount },
      data: {
        pendingBalance: { decrement: amount },
        availableBalance: { increment: amount },
        releasedTotal: { increment: amount },
      },
    });

    if (count === 0) continue;

    released += amount;
    creators += 1;

    // Tell the creator the money is now theirs to withdraw. Without this a
    // balance that was invisible simply appears, and a creator who had written
    // their held money off never learns it moved. Best effort: a notification
    // must never undo a release that already happened.
    try {
      await createNotification({
        userId: balance.creatorId,
        title: "Earnings available 💰",
        message: `TZS ${amount.toLocaleString("en-US")} is now available to withdraw.`,
        type: "success",
        link: "/creator",
        pushTag: "earnings-released",
      });
    } catch (notifyError) {
      console.error(
        "[Earning Release] Notification failed:",
        (notifyError as Error)?.message
      );
    }

    // A creator whose withdrawable balance just crossed the floor can now
    // actually take money out. Firing on the CROSSING (below before, at or above
    // after) rather than on "is above the minimum" is what keeps this from
    // nagging on every release — and it fires again only if a payout drops them
    // back below and they earn past it once more.
    const minPayout = config.business.minPayoutAmount;
    if (
      balance.availableBalance < minPayout &&
      balance.availableBalance + amount >= minPayout
    ) {
      try {
        await createNotification({
          userId: balance.creatorId,
          title: "You can withdraw now 💸",
          message:
            `Your available balance reached TZS ${minPayout.toLocaleString("en-US")}. ` +
            "You can request a withdrawal to M-Pesa, Tigo Pesa, Airtel Money or your bank.",
          type: "success",
          link: "/creator",
          pushTag: "withdraw-ready",
        });
      } catch (nudgeError) {
        console.error(
          "[Earning Release] Withdrawal nudge failed:",
          (nudgeError as Error)?.message
        );
      }
    }
  }

  return { released, creators };
}
