// =============================================================================
// GENHUB - The referral bonus is paid for a customer, not for an email address
//
// The rule this replaces credited the referrer TZS 1,000 the moment an account
// existed. Nothing had to be bought, so the same person could type ten unrelated
// addresses and collect TZS 10,000 of wallet balance — which is spendable on
// videos and tips, becomes a creator's pending earnings, and is withdrawn as
// real money after 14 days. The platform was paying out of nothing.
//
// The bonus now rides on the invited person's first SETTLED payment, released
// from processPaymentWebhook (the one place gateway money lands). What these
// tests pin:
//
//   1. nothing is paid for an account nobody invited;
//   2. the first settled payment pays once — TZS 1,000, wallet balance,
//      lifetime earnings, a notification and the referrer's cached profile;
//   3. a second payment for the same person pays NOTHING, and the guard is the
//      bonus row's own id, so it holds across two webhooks settling at once;
//   4. one referrer cannot collect without limit in a day.
//
// Prisma and the cache are mocked; the service is real.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  countBonuses: vi.fn(),
  createBonus: vi.fn(),
  createNotification: vi.fn(),
  cacheDel: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    transaction: { count: mocks.countBonuses, create: mocks.createBonus },
    notification: { create: mocks.createNotification },
    // Interactive transaction: the callback is handed a client whose writes are
    // the same spies, so an assertion about "what was credited" is about the
    // real work, not about which object it was done through.
    $transaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/redis", () => ({
  cacheDel: mocks.cacheDel,
}));

import {
  REFERRAL_BONUS_AMOUNT,
  REFERRAL_BONUS_DAILY_CAP,
  referralBonusTransactionId,
  releaseReferralBonus,
} from "@/lib/services/referral.service";

/** An invited customer: their row is what carries the attribution. */
function invited(referrerId: string | null) {
  mocks.userFindUnique.mockResolvedValue({
    id: "viewer-1",
    referredById: referrerId,
    displayName: "Amani Juma",
    username: "amani",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countBonuses.mockResolvedValue(0);
  mocks.createBonus.mockResolvedValue({ id: "bonus" });
  mocks.userUpdate.mockResolvedValue({});
  mocks.createNotification.mockResolvedValue({});
  mocks.cacheDel.mockResolvedValue(undefined);
  mocks.runTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      transaction: { create: mocks.createBonus },
      user: { update: mocks.userUpdate },
      notification: { create: mocks.createNotification },
    })
  );
});

describe("releaseReferralBonus", () => {
  it("pays nothing for a customer nobody invited", async () => {
    invited(null);

    const result = await releaseReferralBonus({ referredUserId: "viewer-1" });

    expect(result).toEqual({ paid: false, reason: "NOT_REFERRED" });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("pays the referrer once, with the wallet, the tally and a notification", async () => {
    invited("referrer-1");

    const result = await releaseReferralBonus({ referredUserId: "viewer-1" });

    expect(result).toEqual({ paid: true, referrerId: "referrer-1" });

    const bonus = mocks.createBonus.mock.calls[0][0] as {
      data: { id: string; userId: string; amount: number; type: string; status: string };
    };
    // The id is derived from the INVITED account, which is what makes the row
    // itself the record that this invitation has been paid.
    expect(bonus.data.id).toBe(referralBonusTransactionId("viewer-1"));
    expect(bonus.data.userId).toBe("referrer-1");
    expect(bonus.data.amount).toBe(REFERRAL_BONUS_AMOUNT);
    expect(bonus.data.type).toBe("REFERRAL_BONUS");
    expect(bonus.data.status).toBe("SUCCESS");

    const credit = mocks.userUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { walletBalance: { increment: number }; referralEarnings: { increment: number } };
    };
    expect(credit.where.id).toBe("referrer-1");
    expect(credit.data.walletBalance.increment).toBe(REFERRAL_BONUS_AMOUNT);
    expect(credit.data.referralEarnings.increment).toBe(REFERRAL_BONUS_AMOUNT);

    const notification = mocks.createNotification.mock.calls[0][0] as {
      data: { userId: string; message: string };
    };
    expect(notification.data.userId).toBe("referrer-1");
    expect(notification.data.message).toContain(REFERRAL_BONUS_AMOUNT.toLocaleString());

    // The referrer's cached profile carries the old balance.
    expect(mocks.cacheDel).toHaveBeenCalledWith("user:referrer-1:*");
  });

  it("refuses to pay twice for the same invitation", async () => {
    invited("referrer-1");
    // The second release loses the race for the bonus row's primary key.
    mocks.createBonus.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    );

    const result = await releaseReferralBonus({ referredUserId: "viewer-1" });

    expect(result).toEqual({ paid: false, reason: "ALREADY_PAID" });
    // Nothing was credited: the claim comes first, so a duplicate pays nothing.
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("caps how much one referrer can collect in a day", async () => {
    invited("referrer-1");
    mocks.countBonuses.mockResolvedValue(REFERRAL_BONUS_DAILY_CAP);

    const result = await releaseReferralBonus({ referredUserId: "viewer-1" });

    expect(result).toEqual({ paid: false, reason: "DAILY_CAP" });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("counts only the referrer's bonuses, over a rolling day", async () => {
    invited("referrer-1");

    await releaseReferralBonus({ referredUserId: "viewer-1" });

    const query = mocks.countBonuses.mock.calls[0][0] as {
      where: { userId: string; type: string; createdAt: { gte: Date } };
    };
    expect(query.where.userId).toBe("referrer-1");
    expect(query.where.type).toBe("REFERRAL_BONUS");
    // A rolling day, with a few seconds of slack for the clock moving between
    // the call under test and this assertion.
    const window = Date.now() - query.where.createdAt.gte.getTime();
    expect(window).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(window).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
  });

  it("never throws when the write fails, because a settlement must not be undone", async () => {
    invited("referrer-1");
    mocks.runTransaction.mockRejectedValue(new Error("database is gone"));

    const result = await releaseReferralBonus({ referredUserId: "viewer-1" });

    expect(result).toEqual({ paid: false, reason: "ERROR" });
  });
});
