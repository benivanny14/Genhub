// =============================================================================
// GENHUB - Referral bonus
//
// TZS 1,000 to whoever invited a customer, released when that customer's FIRST
// real payment settles.
//
// The rule this replaces paid at sign-up. Nothing had to be bought, so it was
// free money for anybody with a text field: type ten unrelated email addresses,
// collect TZS 10,000, spend it on videos and tips. That balance becomes a
// creator's pending earnings and then a real payout after 14 days, so the
// platform handed out cash that no sale had ever funded. Requiring an email
// first only makes the fiction slower to type.
//
// What is required now is a settled payment — money that actually arrived
// through the gateway (processPaymentWebhook is the only place that happens).
// A referrer who farms accounts has to pay for every one of them, and the
// daily cap stops the pattern even so.
//
// Two guards, because a bonus is a write of real money:
//
//   * IDEMPOTENCY. The bonus row's id is derived from the invited account
//     (`referral_<userId>`), so the row itself is the record that this person
//     has already earned their bonus — no extra column, no counter to drift,
//     and the UNIQUE primary key makes a double release impossible even when a
//     webhook and a status poll settle the same order at the same moment.
//     Two payments by the same customer still pay exactly once; the second
//     write is refused by the database.
//   * A DAILY CAP per referrer. Even a real payment can be self-dealt — buy
//     your own TZS 500 video from a second account and take TZS 1,000 back —
//     so the number of bonuses one account can collect in a day is bounded.
//
// Nothing here may throw: it runs after a customer's money has been recorded,
// and a settlement must never fail because a bonus could not be paid.
// =============================================================================

import prisma from "../db";
import { cacheDel } from "../redis";
import { displayHandle } from "../usernames";
import { pushForNotification } from "./notify.service";

export const REFERRAL_BONUS_AMOUNT = 1000;

/**
 * How many bonuses one referrer can collect in a rolling day.
 *
 * Five is more than a person invites in a day and far below a farm; the point
 * is not to limit real referrals, it is to stop a loop.
 */
export const REFERRAL_BONUS_DAILY_CAP = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The id of the bonus paid for inviting `referredUserId`.
 *
 * Deterministic because it is also the idempotency key — the row's existence is
 * what says "this invitation has been paid".
 */
export function referralBonusTransactionId(referredUserId: string): string {
  return `referral_${referredUserId}`;
}

export type ReferralBonusResult =
  | { paid: true; referrerId: string }
  | { paid: false; reason: "NOT_REFERRED" | "ALREADY_PAID" | "DAILY_CAP" | "ERROR" };

/**
 * Pay the referrer for `referredUserId`, once.
 *
 * Safe to call on every settled payment the invited person makes: the first call
 * pays, the rest are refused by the bonus row's primary key.
 */
export async function releaseReferralBonus(params: {
  referredUserId: string;
}): Promise<ReferralBonusResult> {
  const { referredUserId } = params;

  try {
    const referred = await prisma.user.findUnique({
      where: { id: referredUserId },
      select: { id: true, referredById: true, displayName: true, username: true },
    });

    if (!referred?.referredById) return { paid: false, reason: "NOT_REFERRED" };
    const referrerId = referred.referredById;

    const paidToday = await prisma.transaction.count({
      where: {
        userId: referrerId,
        type: "REFERRAL_BONUS",
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (paidToday >= REFERRAL_BONUS_DAILY_CAP) {
      console.warn(`[Referral] Daily cap reached for ${referrerId}`);
      return { paid: false, reason: "DAILY_CAP" };
    }

    await prisma.$transaction(async (tx) => {
      // The claim comes FIRST. Inside a transaction the unique violation aborts
      // everything after it, so nothing else may be written before this line —
      // create-then-credit is what makes "credited twice" impossible rather than
      // merely unlikely.
      await tx.transaction.create({
        data: {
          id: referralBonusTransactionId(referredUserId),
          userId: referrerId,
          amount: REFERRAL_BONUS_AMOUNT,
          type: "REFERRAL_BONUS",
          status: "SUCCESS",
          metadata: { referredUserId },
        },
      });

      await tx.user.update({
        where: { id: referrerId },
        data: {
          walletBalance: { increment: REFERRAL_BONUS_AMOUNT },
          referralEarnings: { increment: REFERRAL_BONUS_AMOUNT },
        },
      });

      await tx.notification.create({
        data: {
          userId: referrerId,
          title: "Referral bonus! 🎉",
          message: `${displayHandle(referred, "Someone you invited")} made their first payment — TZS ${REFERRAL_BONUS_AMOUNT.toLocaleString()} added to your wallet.`,
          type: "success",
          link: "/wallet",
        },
      });
    });

    // The in-app notice was written inside the transaction; the lock-screen
    // mirror fires here, after the money actually moved.
    void pushForNotification({
      userId: referrerId,
      title: "Referral bonus! 🎉",
      message: `${displayHandle(referred, "Someone you invited")} made their first payment — TZS ${REFERRAL_BONUS_AMOUNT.toLocaleString()} added to your wallet.`,
      link: "/wallet",
    });

    // The referrer's cached profile carries the old balance (and the wallet page
    // reads it), so it is dropped here rather than left to expire.
    await cacheDel(`user:${referrerId}:*`);

    return { paid: true, referrerId };
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      // Already paid for this invitation.
      return { paid: false, reason: "ALREADY_PAID" };
    }
    console.error("[Referral Bonus Error]", error);
    return { paid: false, reason: "ERROR" };
  }
}
