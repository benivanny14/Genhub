// =============================================================================
// GENHUB - Payout threshold alerts
//
// Tells the admins when a creator's withdrawable balance reaches the payout
// floor (config.business.minPayoutAmount, TZS 30,000) — the point at which that
// creator can ask for a withdrawal — so the money side is watched rather than
// discovered. The admin panel's "Ready to withdraw" tab reads the same condition
// live; this is the push that points at it.
//
// Fires ONCE per crossing, not once per sale. A crossing is remembered on
// CreatorBalance.payoutReadyNotifiedAt and cleared when a payout (or a refund)
// takes the balance back below the floor, so the next time they earn past it the
// admins are told again — but a creator with 20 sales over the floor is not 20
// notifications.
//
// Never throws: it runs after a sale has already been settled, and a missed
// alert must never fail a payment that succeeded. Every path is best-effort.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { notifyAdmins } from "./notify.service";

export interface PayoutReadyAlertResult {
  /** Creators whose crossing was announced in this run. */
  alerted: number;
  /** Creators taken back below the floor (marker cleared). */
  cleared: number;
}

/**
 * Announce one creator's crossing, if it has not been announced yet.
 *
 * Returns true when this call is the one that announced it. Safe to call after
 * every credit: it does nothing while the creator is below the floor or already
 * announced.
 */
export async function maybeNotifyAdminsPayoutReady(creatorId: string): Promise<boolean> {
  try {
    const minimum = config.business.minPayoutAmount;

    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId },
      select: {
        availableBalance: true,
        payoutReadyNotifiedAt: true,
        creator: { select: { displayName: true, email: true } },
      },
    });
    if (!balance) return false;

    // Below the floor: forget the last announcement so the next crossing counts
    // as a new one. This is what makes a payout-and-earn-again cycle re-alert.
    if (balance.availableBalance < minimum) {
      if (balance.payoutReadyNotifiedAt) {
        await prisma.creatorBalance.updateMany({
          where: { creatorId, payoutReadyNotifiedAt: { not: null } },
          data: { payoutReadyNotifiedAt: null },
        });
      }
      return false;
    }

    if (balance.payoutReadyNotifiedAt) return false; // already announced

    // Claim the announcement BEFORE sending anything, so two credits landing
    // together cannot both announce the same crossing. The loser gets count 0
    // and stays silent.
    const claimed = await prisma.creatorBalance.updateMany({
      where: { creatorId, payoutReadyNotifiedAt: null },
      data: { payoutReadyNotifiedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    const name =
      balance.creator?.displayName || balance.creator?.email || "A creator";

    // The crossing itself, not the request: a creator who has just reached the
    // floor can withdraw, and this is the alert that says a decision is coming.
    // The request alert is separate, and fires when they actually ask.
    await notifyAdmins({
      title: "Creator ready to withdraw 💸",
      message:
        `${name}'s available balance reached TZS ${minimum.toLocaleString("en-US")}. ` +
        "Open Admin → Ready to withdraw to review the request, allow a smaller " +
        "withdrawal, or freeze the account.",
      type: "info",
      link: "/admin",
      pushTag: "payout-ready",
    });

    return true;
  } catch (error) {
    console.warn(
      "[Payout Threshold] Alert failed:",
      (error as Error)?.message
    );
    return false;
  }
}

/**
 * Sweep every creator whose balance has crossed the floor, for the scheduled
 * job. The per-sale alert above covers the normal case; this is the backstop for
 * a credit path that forgot to nudge (or a backlog carried over from before the
 * alert existed).
 */
export async function sweepPayoutReadyAlerts(): Promise<PayoutReadyAlertResult> {
  try {
    const minimum = config.business.minPayoutAmount;

    const ready = await prisma.creatorBalance.findMany({
      where: { availableBalance: { gte: minimum }, payoutReadyNotifiedAt: null },
      select: { creatorId: true },
      take: 200,
    });

    let alerted = 0;
    for (const row of ready) {
      if (await maybeNotifyAdminsPayoutReady(row.creatorId)) alerted += 1;
    }

    const cleared = await prisma.creatorBalance.updateMany({
      where: {
        availableBalance: { lt: minimum },
        payoutReadyNotifiedAt: { not: null },
      },
      data: { payoutReadyNotifiedAt: null },
    });

    return { alerted, cleared: cleared.count };
  } catch (error) {
    console.warn("[Payout Threshold] Sweep failed:", (error as Error)?.message);
    return { alerted: 0, cleared: 0 };
  }
}
