// =============================================================================
// GENHUB - The weekly creator earnings digest
//
// A creator earns on a per-sale clock, and their share lands in their balance
// the moment a sale completes — there is no holding period. Because the money
// side is otherwise only visible inside the app, one email a week keeps the
// creator up to date: what they earned, and what is available to withdraw.
//
// Once a week, a creator with anything to report gets one email: what came in
// this week, their withdrawable balance, and the rule that gates a payout.
//
// Two properties matter more than the wording:
//
//   * At most once a week, per creator. The worker runs on the cron supervisor's
//     poke, which is hours apart but never exactly seven days, so the week is
//     enforced here (User.lastEarningsDigestAt), not by the schedule. The week is
//     claimed with a conditional update BEFORE the send: two pokes racing must
//     not both send, and the loser of that race sends nothing.
//   * Never for a creator with nothing to report. No earnings means no email, and
//     crucially it does not consume the week — somebody who starts selling
//     tomorrow still gets the next digest.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { sendEarningsDigestEmail } from "../email";

export interface EarningsDigestResult {
  /** Creators with an email that were considered. */
  checked: number;
  sent: number;
  skipped: number;
  /** Sends that threw — sendMail itself never throws. */
  errors: number;
}

/** One calendar week, the digest's own cadence. */
const WEEK_MS = 7 * 86_400_000;

/**
 * Send the digest to every creator who is due one and has something to report.
 *
 * `now` is injectable so the week boundary can be tested without waiting.
 */
export async function sendDueEarningsDigests(
  now: Date = new Date()
): Promise<EarningsDigestResult> {
  const creators = await prisma.user.findMany({
    // Opt-out: the digest is on unless a creator turned it off, and it needs an
    // address to reach in the first place.
    where: { role: "CREATOR", email: { not: null }, earningsDigestEnabled: true },
    select: {
      id: true,
      email: true,
      displayName: true,
      locale: true,
      lastEarningsDigestAt: true,
      creatorBalance: {
        select: {
          availableBalance: true,
          totalEarned: true,
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const creator of creators) {
    if (
      creator.lastEarningsDigestAt &&
      now.getTime() - creator.lastEarningsDigestAt.getTime() < WEEK_MS
    ) {
      skipped++;
      continue;
    }

    const balance = creator.creatorBalance;
    // Nothing earned yet: quiet, and the week is left unconsumed so the first
    // digest arrives as soon as there is something in it.
    if (!balance || balance.totalEarned <= 0) {
      skipped++;
      continue;
    }

    // What the creator earned in the last seven days — the week the email is
    // about. Every sale is income the moment it settles, so this is the same
    // figure their balance grew by, not a slice of it that "cleared".
    const weekSince = new Date(now.getTime() - WEEK_MS);
    const week = await prisma.transaction.aggregate({
      where: {
        creatorId: creator.id,
        status: "SUCCESS",
        creatorCut: { not: null },
        createdAt: { gt: weekSince },
      },
      _sum: { creatorCut: true },
    });
    const earnedThisWeek = week._sum.creatorCut ?? 0;

    // Nothing earned this week and nothing to withdraw: stay quiet rather than
    // send a "you have TZS 0" email. The balance row can exist with a
    // withdrawable balance the creator already knows about, so available counts
    // as something to say.
    if (earnedThisWeek <= 0 && balance.availableBalance <= 0) {
      skipped++;
      continue;
    }

    // Claim the week before sending. The conditional update is the guard against
    // two pokes sending the same digest; whoever loses it sends nothing.
    const claim = await prisma.user.updateMany({
      where: {
        id: creator.id,
        OR: [
          { lastEarningsDigestAt: null },
          { lastEarningsDigestAt: { lte: new Date(now.getTime() - WEEK_MS) } },
        ],
      },
      data: { lastEarningsDigestAt: now },
    });
    if (claim.count === 0) {
      skipped++;
      continue;
    }

    try {
      await sendEarningsDigestEmail({
        to: creator.email!,
        displayName: creator.displayName ?? "",
        locale: creator.locale,
        earnedThisWeek,
        available: balance.availableBalance,
        totalEarned: balance.totalEarned,
        minWithdrawal: config.business.minPayoutAmount,
      });
      sent++;
    } catch (error) {
      // sendMail is best-effort and does not throw; anything reaching here is a
      // bug in the summary worth counting, not worth failing the whole run for.
      errors++;
      console.error(
        "[Earnings Digest] send failed:",
        (error as Error)?.message
      );
    }
  }

  return { checked: creators.length, sent, skipped, errors };
}
