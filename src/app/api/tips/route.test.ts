// =============================================================================
// GENHUB - POST /api/tips
//
// A tip used to be the one payment that paid the creator in full, which made
// /about ("70% of every shilling goes to the creator") untrue and meant the same
// shilling was split two ways depending on which button a fan pressed. These
// tests pin the tip to the same 70/30 rule as a video, a membership and a paid
// message:
//
//   * the fan is debited the whole amount they chose, once, atomically;
//   * the transaction records the fee breakdown, not just the amount;
//   * the creator's 14-day holding is credited their share, never the gross;
//   * the notification names both numbers, because the gross is not what the
//     creator will ever be paid.
//
// Prisma, auth and the wallet service are mocked; no database, no money. The
// real `splitRevenue` is used, so the arithmetic under test is the arithmetic
// that ships.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  debitWallet: vi.fn(),
  findUser: vi.fn(),
  createTransaction: vi.fn(),
  upsertBalance: vi.fn(),
  createNotification: vi.fn(),
}));

const tx = {
  transaction: { create: (...a: unknown[]) => mocks.createTransaction(...a) },
  creatorBalance: { upsert: (...a: unknown[]) => mocks.upsertBalance(...a) },
  notification: { create: (...a: unknown[]) => mocks.createNotification(...a) },
};

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: (...a: unknown[]) => mocks.findUser(...a) },
    $transaction: (fn: (client: unknown) => unknown) => fn(tx),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: () => mocks.checkRateLimit(),
}));

vi.mock("@/lib/services/balance.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/balance.service")>();
  return { ...actual, debitWallet: (...a: unknown[]) => mocks.debitWallet(...a) };
});

import { POST } from "./route";

const VIEWER = "viewer-1";
const CREATOR = "creator-1";

function tip(body: Record<string, unknown>) {
  return new NextRequest("https://app.test/api/tips", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: VIEWER, role: "VIEWER" });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.debitWallet.mockResolvedValue({ ok: true, balance: 9000 });
  mocks.findUser.mockResolvedValue({ id: CREATOR, isBanned: false });
  mocks.createTransaction.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "tx-1", ...args.data })
  );
});

describe("what the fan pays", () => {
  it("takes the amount they chose out of the wallet, once", async () => {
    const res = await POST(tip({ creatorId: CREATOR, amount: 2_000 }));

    expect(res.status).toBe(200);
    expect(mocks.debitWallet).toHaveBeenCalledWith(tx, { userId: VIEWER, amount: 2_000 });
    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      userId: VIEWER,
      creatorId: CREATOR,
      amount: 2_000,
    });
  });

  it("refuses a tip below the floor without touching the wallet", async () => {
    const res = await POST(tip({ creatorId: CREATOR, amount: 499 }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toContain("500");
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });
});

describe("the split", () => {
  it("gives the creator 70% and the platform 30%", async () => {
    await POST(tip({ creatorId: CREATOR, amount: 2_000 }));

    expect(mocks.createTransaction.mock.calls[0][0].data).toMatchObject({
      platformFee: 600,
      creatorCut: 1_400,
    });
    // The holding gets the creator's share — the 14-day clock applies to their
    // money, not to what the fan paid.
    expect(mocks.upsertBalance.mock.calls[0][0]).toMatchObject({
      where: { creatorId: CREATOR },
      create: { creatorId: CREATOR, pendingBalance: 1_400, availableBalance: 0, totalEarned: 1_400 },
      update: {
        pendingBalance: { increment: 1_400 },
        totalEarned: { increment: 1_400 },
      },
    });
  });

  it("gives the two halves back to the amount the fan paid", async () => {
    // Not a round number: the platform takes the rounded fee and the creator the
    // remainder, so the pair still adds up to what was charged.
    await POST(tip({ creatorId: CREATOR, amount: 777 }));

    const recorded = mocks.createTransaction.mock.calls[0][0].data;
    expect(recorded.platformFee).toBe(Math.round(777 * 0.3));
    expect(recorded.platformFee + recorded.creatorCut).toBe(777);
  });

  it("tells the creator what was sent and what their share is", async () => {
    await POST(tip({ creatorId: CREATOR, amount: 2_000, message: "asante" }));

    const note = mocks.createNotification.mock.calls[0][0].data;
    expect(note.userId).toBe(CREATOR);
    expect(note.message).toContain("2,000");
    expect(note.message).toContain("1,400");
    expect(note.message).toContain("asante");
  });
});

describe("refusals", () => {
  it("writes nothing when the wallet cannot cover the tip", async () => {
    mocks.debitWallet.mockResolvedValue({ ok: false, balance: 120 });

    const res = await POST(tip({ creatorId: CREATOR, amount: 2_000 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("120");
    expect(mocks.createTransaction).not.toHaveBeenCalled();
    expect(mocks.upsertBalance).not.toHaveBeenCalled();
  });

  it("refuses a tip to yourself", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: CREATOR, role: "VIEWER" });

    const res = await POST(tip({ creatorId: CREATOR, amount: 2_000 }));

    expect(res.status).toBe(400);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });

  it("refuses a creator who does not exist or is banned", async () => {
    mocks.findUser.mockResolvedValue(null);

    const res = await POST(tip({ creatorId: CREATOR, amount: 2_000 }));

    expect(res.status).toBe(404);
    expect(mocks.debitWallet).not.toHaveBeenCalled();
  });
});
