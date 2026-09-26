// =============================================================================
// GENHUB - The blue tick: price, payment source, approval and expiry
//
// Four things about this feature are easy to get subtly wrong, and none of them
// would show up on the happy path:
//
//   * the badge is BOUGHT, so `isVerified` alone no longer answers "is it
//     showing?" — a month that has run out has to read as gone (blueTickIsLive);
//   * money may come from two places, and the choice decides where a rejection
//     refunds to — refunding a wallet charge into earnings moves a creator's
//     money to an account they never spent from;
//   * a charge and its request row are one transaction, so a creator can never
//     be charged for a request that was not stored;
//   * months are clamped, or a crafted `{ months: 9999 }` invents a price.
//
// Prisma, config and the wallet debit are mocked; no database, no clock games
// beyond the fixed dates used below.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  balanceFindUnique: vi.fn(),
  balanceUpdateMany: vi.fn(),
  balanceUpsert: vi.fn(),
  requestFindUnique: vi.fn(),
  requestFindFirst: vi.fn(),
  requestFindMany: vi.fn(),
  requestCreate: vi.fn(),
  requestUpdate: vi.fn(),
  requestUpdateMany: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerUpdate: vi.fn(),
  notificationCreate: vi.fn(),
  notificationCreateMany: vi.fn(),
  adminFindMany: vi.fn(),
  debitWallet: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    user: {
      findUnique: (...a: unknown[]) => mocks.userFindUnique(...a),
      update: (...a: unknown[]) => mocks.userUpdate(...a),
      updateMany: (...a: unknown[]) => mocks.userUpdateMany(...a),
      findMany: (...a: unknown[]) => mocks.adminFindMany(...a),
    },
    creatorBalance: {
      findUnique: (...a: unknown[]) => mocks.balanceFindUnique(...a),
      updateMany: (...a: unknown[]) => mocks.balanceUpdateMany(...a),
      upsert: (...a: unknown[]) => mocks.balanceUpsert(...a),
    },
    blueTickRequest: {
      findUnique: (...a: unknown[]) => mocks.requestFindUnique(...a),
      findFirst: (...a: unknown[]) => mocks.requestFindFirst(...a),
      findMany: (...a: unknown[]) => mocks.requestFindMany(...a),
      create: (...a: unknown[]) => mocks.requestCreate(...a),
      update: (...a: unknown[]) => mocks.requestUpdate(...a),
      updateMany: (...a: unknown[]) => mocks.requestUpdateMany(...a),
    },
    transaction: {
      create: (...a: unknown[]) => mocks.ledgerCreate(...a),
      update: (...a: unknown[]) => mocks.ledgerUpdate(...a),
    },
    notification: {
      create: (...a: unknown[]) => mocks.notificationCreate(...a),
      createMany: (...a: unknown[]) => mocks.notificationCreateMany(...a),
    },
  };

  return {
    default: {
      ...tx,
      // The whole service is written against the callback form, and the debit,
      // the request row and the ledger row have to commit together.
      $transaction: (fn: (client: unknown) => unknown) => fn(tx),
    },
  };
});

vi.mock("@/lib/config", () => ({
  default: { business: { blueTickMonthlyPrice: 10_000, blueTickMonthDays: 30 } },
}));

vi.mock("@/lib/services/balance.service", () => ({
  debitWallet: (...a: unknown[]) => mocks.debitWallet(...a),
}));

import {
  approveBlueTick,
  blueTickExpiryFrom,
  blueTickIsLive,
  getBlueTickView,
  reconcileUserBlueTick,
  rejectBlueTick,
  requestBlueTick,
  BLUE_TICK_PRICE,
  BLUE_TICK_MONTH_DAYS,
  MAX_BLUE_TICK_MONTHS,
} from "@/lib/services/blue-tick.service";

const DAY = 86_400_000;
const CREATOR = "creator-1";

const liveUntil = (date: Date) => ({ isVerified: true, verifiedUntil: date });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userUpdateMany.mockResolvedValue({ count: 0 });
  mocks.requestUpdateMany.mockResolvedValue({ count: 0 });
  mocks.adminFindMany.mockResolvedValue([]);
  mocks.requestCreate.mockResolvedValue({ id: "req-1" });
  mocks.ledgerCreate.mockResolvedValue({ id: "txn-1" });
  mocks.notificationCreate.mockResolvedValue({});
  mocks.notificationCreateMany.mockResolvedValue({ count: 0 });
  mocks.userUpdate.mockResolvedValue({});
  mocks.requestUpdate.mockResolvedValue({});
  mocks.requestFindFirst.mockResolvedValue(null);
  mocks.balanceUpdateMany.mockResolvedValue({ count: 0 });
});

describe("blueTickIsLive", () => {
  it("is false for an unverified account", () => {
    expect(blueTickIsLive({ isVerified: false, verifiedUntil: null })).toBe(false);
  });

  it("is true when an admin granted it and it therefore never expires", () => {
    expect(blueTickIsLive({ isVerified: true, verifiedUntil: null })).toBe(true);
  });

  it("is true while the bought month is still running", () => {
    expect(blueTickIsLive(liveUntil(new Date(Date.now() + DAY)))).toBe(true);
  });

  it("is false once the bought month has ended, even though the flag is still set", () => {
    // The sweep may not have run yet — the profile must not depend on it.
    expect(blueTickIsLive(liveUntil(new Date(Date.now() - 1000)))).toBe(false);
  });
});

describe("blueTickExpiryFrom", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");

  it("adds exactly one configured month", () => {
    expect(blueTickExpiryFrom(from, 1).getTime()).toBe(
      from.getTime() + BLUE_TICK_MONTH_DAYS * DAY
    );
  });

  it("multiplies by the months bought", () => {
    expect(blueTickExpiryFrom(from, 6).getTime()).toBe(
      from.getTime() + 6 * BLUE_TICK_MONTH_DAYS * DAY
    );
  });
});

describe("requestBlueTick", () => {
  function creator(overrides: Record<string, unknown> = {}) {
    return {
      id: CREATOR,
      role: "CREATOR",
      displayName: "Asha",
      email: "asha@example.com",
      isVerified: false,
      verifiedUntil: null,
      walletBalance: 0,
      ...overrides,
    };
  }

  it("refuses an account that is not a creator", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ role: "VIEWER" }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 50_000 });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_CREATOR");
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("refuses to charge for a badge that is already live", async () => {
    mocks.userFindUnique.mockResolvedValue(
      creator({ isVerified: true, verifiedUntil: new Date(Date.now() + DAY) })
    );
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ALREADY_ACTIVE");
  });

  it("refuses a second charge while one is still waiting for an admin", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 50_000 }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });
    mocks.requestFindFirst.mockResolvedValue({ id: "already-waiting" });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AWAITING_REVIEW");
  });

  it("pays from the wallet when the wallet covers it", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 25_000 }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 40_000 });
    mocks.debitWallet.mockResolvedValue({ ok: true, balance: 15_000 });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("WALLET");
    // Earnings are untouched: the wallet was sufficient, so the creator's
    // withdrawable balance must not move.
    expect(mocks.balanceUpdateMany).not.toHaveBeenCalled();
    const created = mocks.requestCreate.mock.calls[0][0];
    expect(created.data).toMatchObject({
      amount: BLUE_TICK_PRICE,
      months: 1,
      status: "PAID",
      paymentMethod: "WALLET",
    });
  });

  it("falls back to cleared earnings when the wallet is short", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 4_000 }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 60_000 });
    mocks.balanceUpdateMany.mockResolvedValue({ count: 1 });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("EARNINGS");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
    expect(mocks.requestCreate.mock.calls[0][0].data.paymentMethod).toBe("EARNINGS");
  });

  it("refuses when neither balance covers the price", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 9_999 }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 9_999 });

    const result = await requestBlueTick({ userId: CREATOR });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("INSUFFICIENT_FUNDS");
      expect(result.needed).toBe(BLUE_TICK_PRICE);
    }
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("clamps a crafted months value to what the platform sells", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 1_000_000 }));
    mocks.debitWallet.mockResolvedValue({ ok: true, balance: 0 });
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });

    const result = await requestBlueTick({ userId: CREATOR, months: 9_999 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.months).toBe(MAX_BLUE_TICK_MONTHS);
      expect(result.amount).toBe(BLUE_TICK_PRICE * MAX_BLUE_TICK_MONTHS);
    }
  });

  it("treats a missing or nonsense months value as one month", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 1_000_000 }));
    mocks.debitWallet.mockResolvedValue({ ok: true, balance: 0 });
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });

    const result = await requestBlueTick({ userId: CREATOR, months: Number.NaN });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.months).toBe(1);
  });

  it("tells every admin, in the same transaction as the charge", async () => {
    mocks.userFindUnique.mockResolvedValue(creator({ walletBalance: 25_000 }));
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });
    mocks.debitWallet.mockResolvedValue({ ok: true, balance: 15_000 });
    mocks.adminFindMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);

    await requestBlueTick({ userId: CREATOR });

    const notified = mocks.notificationCreateMany.mock.calls[0][0];
    expect(notified.data).toHaveLength(2);
    expect(notified.data.map((n: { userId: string }) => n.userId)).toEqual([
      "admin-1",
      "admin-2",
    ]);
  });
});

describe("reconcileUserBlueTick", () => {
  it("does nothing when the month has not ended", async () => {
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });

    await expect(reconcileUserBlueTick(CREATOR)).resolves.toBe(false);
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("clears the badge and closes the request when it has", async () => {
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });

    await expect(reconcileUserBlueTick(CREATOR)).resolves.toBe(true);

    // Only rows whose expiry has actually passed — the conditional update is
    // what makes this safe to call on every profile view.
    const cleared = mocks.userUpdateMany.mock.calls[0][0];
    expect(cleared.where).toMatchObject({ id: CREATOR, isVerified: true });
    expect(cleared.data).toEqual({ isVerified: false, verifiedUntil: null });
  });
});

describe("approveBlueTick", () => {
  it("makes the badge live for the months bought and dates its end", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      userId: CREATOR,
      amount: 10_000,
      months: 3,
      status: "PAID",
      paymentMethod: "WALLET",
      transactionId: "txn-1",
      paidAt: new Date(),
    });

    const before = Date.now();
    const result = await approveBlueTick({ requestId: "req-1", adminId: "admin-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBeTruthy();
      const expiry = new Date(result.expiresAt as string).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 3 * BLUE_TICK_MONTH_DAYS * DAY);
      expect(result.refunded).toBe(false);
    }

    const updated = mocks.userUpdate.mock.calls[0][0];
    expect(updated.data.isVerified).toBe(true);
    expect(updated.data.verifiedUntil).toBeInstanceOf(Date);
  });

  it("refuses a request that was already reviewed", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      userId: CREATOR,
      months: 1,
      status: "APPROVED",
      paidAt: new Date(),
    });

    const result = await approveBlueTick({ requestId: "req-1", adminId: "admin-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ALREADY_REVIEWED");
  });
});

describe("rejectBlueTick", () => {
  it("refunds to the earnings balance when that is where the money came from", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      userId: CREATOR,
      amount: 10_000,
      months: 1,
      status: "PAID",
      paymentMethod: "EARNINGS",
      transactionId: "txn-1",
      paidAt: new Date(),
    });

    const result = await rejectBlueTick({ requestId: "req-1", adminId: "admin-1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.refunded).toBe(true);
    expect(mocks.balanceUpsert.mock.calls[0][0].update.availableBalance).toEqual({
      increment: 10_000,
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    // The charge is marked refunded so the ledger reads like any other refund.
    expect(mocks.ledgerUpdate.mock.calls[0][0].data.status).toBe("REFUNDED");
  });

  it("refunds to the wallet when that is where the money came from", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "req-1",
      userId: CREATOR,
      amount: 10_000,
      months: 1,
      status: "PAID",
      paymentMethod: "WALLET",
      transactionId: "txn-1",
      paidAt: new Date(),
    });

    await rejectBlueTick({ requestId: "req-1", adminId: "admin-1" });

    expect(mocks.userUpdate.mock.calls[0][0].data.walletBalance).toEqual({
      increment: 10_000,
    });
    expect(mocks.balanceUpsert).not.toHaveBeenCalled();
  });
});

describe("getBlueTickView", () => {
  it("reports an expired month as not live, and says where the money can come from", async () => {
    mocks.userFindUnique.mockResolvedValue({
      isVerified: true,
      verifiedUntil: new Date(Date.now() - DAY),
      walletBalance: 0,
    });
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 12_000 });
    mocks.requestFindMany.mockResolvedValue([]);

    const view = await getBlueTickView(CREATOR);

    expect(view.live).toBe(false);
    expect(view.price).toBe(BLUE_TICK_PRICE);
    expect(view.canAfford).toBe(true);
    expect(view.pending).toBeNull();
  });

  it("surfaces a paid request that is still waiting for a decision", async () => {
    mocks.userFindUnique.mockResolvedValue({
      isVerified: false,
      verifiedUntil: null,
      walletBalance: 0,
    });
    mocks.balanceFindUnique.mockResolvedValue({ availableBalance: 0 });
    mocks.requestFindMany.mockResolvedValue([
      {
        id: "req-1",
        status: "PAID",
        amount: 10_000,
        months: 1,
        paymentMethod: "WALLET",
        paidAt: new Date(),
        expiresAt: null,
        rejectionReason: null,
      },
    ]);

    const view = await getBlueTickView(CREATOR);

    expect(view.pending?.id).toBe("req-1");
    expect(view.pending?.amount).toBe(10_000);
  });
});
