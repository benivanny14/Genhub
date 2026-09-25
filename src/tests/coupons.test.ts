// =============================================================================
// GENHUB - Spending a coupon
//
// Two bugs lived here and both cost money, so both are pinned:
//
//   1. The limit was decided in JavaScript (`usedCount >= maxUses` was a read),
//      so two checkouts arriving together both passed and a one-use coupon could
//      be spent any number of times. The rule is now inside the UPDATE.
//   2. A coupon was consumed at CHECKOUT, so a customer who never approved the
//      USSD prompt burned a limited coupon without buying anything.
//
// `maxUses` is also a global budget that said nothing about a person: one account
// could spend all of it. CouponRedemption is the per-account rule, and its unique
// pair is what makes the write safe when two settlements race.
//
// Prisma is mocked through a transaction stub, so the sequence of statements is
// what is being asserted, not a database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  couponFindUnique: vi.fn(),
  redemptionFindUnique: vi.fn(),
  redemptionCreate: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    coupon: { findUnique: mocks.couponFindUnique },
    couponRedemption: {
      findUnique: mocks.redemptionFindUnique,
      create: mocks.redemptionCreate,
    },
    $executeRaw: mocks.executeRaw,
    $transaction: mocks.transaction,
  },
}));

import { applyCoupon, consumeCoupon } from "@/lib/coupons";

const COUPON = {
  id: "coupon-1",
  code: "WELCOME10",
  type: "PERCENT",
  value: 10,
  isActive: true,
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.couponFindUnique.mockResolvedValue({ ...COUPON });
  mocks.redemptionFindUnique.mockResolvedValue(null);
  mocks.redemptionCreate.mockResolvedValue({ id: "redemption-1" });
  mocks.executeRaw.mockResolvedValue(1);

  // Run the callback against a transaction client that is the same set of mocks,
  // so what is asserted is the ORDER of statements inside the transaction.
  mocks.transaction.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        couponRedemption: {
          findUnique: mocks.redemptionFindUnique,
          create: mocks.redemptionCreate,
        },
        $executeRaw: mocks.executeRaw,
      })
  );
});

describe("consumeCoupon", () => {
  it("counts the redemption and records who spent it", async () => {
    await expect(
      consumeCoupon({ couponId: "coupon-1", userId: "u1", transactionId: "tx-1" })
    ).resolves.toBe("OK");

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.redemptionCreate).toHaveBeenCalledWith({
      data: { couponId: "coupon-1", userId: "u1", transactionId: "tx-1" },
    });
  });

  it("refuses when this user has already spent it", async () => {
    mocks.redemptionFindUnique.mockResolvedValue({ id: "redemption-existing" });

    await expect(
      consumeCoupon({ couponId: "coupon-1", userId: "u1" })
    ).resolves.toBe("ALREADY_USED");

    // The counter must not move: the redemption is what is being refused.
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("refuses when the global budget is gone", async () => {
    // The UPDATE matched nothing, which is the database saying "no" — the state
    // the old read-then-increment could not see.
    mocks.executeRaw.mockResolvedValue(0);

    await expect(
      consumeCoupon({ couponId: "coupon-1", userId: "u1" })
    ).resolves.toBe("EXHAUSTED");

    expect(mocks.redemptionCreate).not.toHaveBeenCalled();
  });

  it("treats a unique-constraint failure as already used, not as an error", async () => {
    // Two settlements arriving together: one insert wins, the loser's whole
    // transaction rolls back, so nothing was counted twice.
    mocks.redemptionCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "5.19.0",
      })
    );

    await expect(
      consumeCoupon({ couponId: "coupon-1", userId: "u1" })
    ).resolves.toBe("ALREADY_USED");
  });

  it("never throws at a settlement", async () => {
    // A settled payment must not be turned into a failure by bookkeeping.
    mocks.redemptionFindUnique.mockRejectedValue(new Error("connection refused"));

    await expect(
      consumeCoupon({ couponId: "coupon-1", userId: "u1" })
    ).resolves.toBe("ERROR");
  });
});

describe("applyCoupon", () => {
  it("prices a percentage coupon off a purchase", async () => {
    await expect(
      applyCoupon({ code: "welcome10", amount: 5000, context: "purchase", userId: "u1" })
    ).resolves.toEqual({
      valid: true,
      couponId: "coupon-1",
      discount: 500,
      finalAmount: 4500,
    });
  });

  it("adds a percentage coupon as a bonus on a top-up", async () => {
    await expect(
      applyCoupon({ code: "WELCOME10", amount: 10000, context: "topup", userId: "u1" })
    ).resolves.toMatchObject({ valid: true, bonus: 1000, finalAmount: 11000 });
  });

  it("never discounts below zero", async () => {
    mocks.couponFindUnique.mockResolvedValue({
      ...COUPON,
      type: "FIXED",
      value: 90000,
    });

    const outcome = await applyCoupon({ code: "BIG", amount: 5000, context: "purchase" });

    expect(outcome.valid).toBe(true);
    expect(outcome.finalAmount).toBe(0);
  });

  it("refuses a coupon this user has already spent", async () => {
    mocks.redemptionFindUnique.mockResolvedValue({ id: "redemption-existing" });

    await expect(
      applyCoupon({ code: "WELCOME10", amount: 5000, context: "purchase", userId: "u1" })
    ).resolves.toMatchObject({ valid: false, error: "You have already used this coupon" });
  });

  it("still previews a coupon for a signed-out visitor", async () => {
    // The paywall checks a code before anybody signs in, so no userId means no
    // per-account rule — only the global one.
    const outcome = await applyCoupon({ code: "WELCOME10", amount: 5000, context: "purchase" });

    expect(outcome.valid).toBe(true);
    expect(mocks.redemptionFindUnique).not.toHaveBeenCalled();
  });

  it("refuses an exhausted or expired coupon", async () => {
    mocks.couponFindUnique.mockResolvedValue({ ...COUPON, usedCount: 1 });
    await expect(
      applyCoupon({ code: "WELCOME10", amount: 5000, context: "purchase" })
    ).resolves.toMatchObject({ valid: false, error: "This coupon has been fully redeemed" });

    mocks.couponFindUnique.mockResolvedValue({
      ...COUPON,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      applyCoupon({ code: "WELCOME10", amount: 5000, context: "purchase" })
    ).resolves.toMatchObject({ valid: false, error: "This coupon has expired" });
  });

  it("refuses a coupon that does not exist, and an empty code", async () => {
    mocks.couponFindUnique.mockResolvedValue(null);
    await expect(
      applyCoupon({ code: "NOPE", amount: 5000, context: "purchase" })
    ).resolves.toMatchObject({ valid: false, error: "This coupon is not valid" });

    await expect(
      applyCoupon({ code: "  ", amount: 5000, context: "purchase" })
    ).resolves.toEqual({ valid: false });
  });
});
