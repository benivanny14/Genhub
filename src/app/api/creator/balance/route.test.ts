// =============================================================================
// GENHUB - GET /api/creator/balance
//
// The one endpoint the creator dashboard reads, and the only place chat income
// reaches the screen. Two things are pinned here, both of which fail silently:
//
//   1. The payload must carry `paidMessages`. The section renders zeros when the
//      key is missing, so a dropped field looks like a creator nobody has
//      messaged rather than a broken endpoint.
//   2. `recentTransactions` must carry `metadata`. Without it a paid message and
//      a plain tip are the same row, and "TIP" is all the dashboard can say.
//   3. `payouts` must carry `paymentReference`. It is the receipt the admin typed
//      when the money was sent, and the dashboard is the only place the creator
//      reads it — a dropped field leaves them with an M-Pesa SMS and no in-app
//      record that the platform agrees.
//
// Prisma, auth and both services are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  releaseMatureEarnings: vi.fn(),
  getPaidMessageEarnings: vi.fn(),
  balanceFindUnique: vi.fn(),
  videoFindMany: vi.fn(),
  earningFindMany: vi.fn(),
  txAggregate: vi.fn(),
  txFindMany: vi.fn(),
  payoutFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    creatorBalance: { findUnique: (...a: unknown[]) => mocks.balanceFindUnique(...a) },
    video: { findMany: (...a: unknown[]) => mocks.videoFindMany(...a) },
    videoEarning: { findMany: (...a: unknown[]) => mocks.earningFindMany(...a) },
    transaction: {
      aggregate: (...a: unknown[]) => mocks.txAggregate(...a),
      findMany: (...a: unknown[]) => mocks.txFindMany(...a),
    },
    payoutRequest: { findMany: (...a: unknown[]) => mocks.payoutFindMany(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: () => mocks.requireRole(),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/services/earning-release.service", () => ({
  releaseMatureEarnings: (...a: unknown[]) => mocks.releaseMatureEarnings(...a),
}));

vi.mock("@/lib/services/paid-message.service", () => ({
  getPaidMessageEarnings: (...a: unknown[]) => mocks.getPaidMessageEarnings(...a),
}));

import { GET } from "./route";

const CREATOR = "creator-1";

const PAID_MESSAGES = {
  messages: 3,
  earned: 4500,
  heldMessages: 2,
  held: 3000,
  cleared: 1500,
  nextReleaseAt: "2026-10-04T09:00:00.000Z",
  recent: [
    {
      id: "m1",
      amount: 1500,
      createdAt: "2026-09-24T09:00:00.000Z",
      clearsAt: "2026-10-08T09:00:00.000Z",
      held: true,
      sender: { id: "v1", displayName: "Asha", avatarUrl: null },
    },
  ],
};

function get() {
  return GET(new NextRequest("https://app.test/api/creator/balance"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ userId: CREATOR, role: "CREATOR" });
  mocks.releaseMatureEarnings.mockResolvedValue({ released: 0, creators: 0 });
  mocks.getPaidMessageEarnings.mockResolvedValue(PAID_MESSAGES);
  mocks.balanceFindUnique.mockResolvedValue({
    pendingBalance: 3000,
    availableBalance: 12000,
    totalEarned: 40000,
  });
  mocks.videoFindMany.mockResolvedValue([]);
  mocks.earningFindMany.mockResolvedValue([]);
  mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 900 } });
  mocks.txFindMany.mockResolvedValue([]);
  mocks.payoutFindMany.mockResolvedValue([]);
});

describe("GET /api/creator/balance", () => {
  it("hands the dashboard the paid-message earnings", async () => {
    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.getPaidMessageEarnings).toHaveBeenCalledWith(CREATOR);
    expect(body.data.paidMessages).toEqual(PAID_MESSAGES);
  });

  it("asks for the transaction metadata that tells a message from a tip", async () => {
    await get();

    expect(mocks.txFindMany.mock.calls[0][0].select.metadata).toBe(true);
  });

  it("nulls the card instead of zeroing it when the ledger read fails", async () => {
    // The card is a report about money that is already recorded; a failure
    // reading it must not take down the balance and the videos on the same page.
    // And it must not answer zeroes either — "nobody has messaged you" is a
    // different statement from "we could not read it".
    mocks.getPaidMessageEarnings.mockRejectedValue(new Error("ledger read failed"));

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.paidMessages).toBeNull();
    expect(body.data.balance.availableBalance).toBe(12000);
  });

  it("reports an empty wallet-shaped balance for a creator with no row yet", async () => {
    mocks.balanceFindUnique.mockResolvedValue(null);

    const res = await get();
    const body = await res.json();

    expect(body.data.balance).toEqual({
      pendingBalance: 0,
      availableBalance: 0,
      totalEarned: 0,
    });
  });

  it("carries the receipt number for a paid withdrawal", async () => {
    mocks.payoutFindMany.mockResolvedValue([
      {
        id: "payout-1",
        amount: 100_000,
        paymentMethod: "MPESA",
        accountDetails: "0754000000",
        status: "PAID",
        paymentReference: "QGR7X8Y2Z1",
        adminNote: null,
        createdAt: "2026-09-24T09:00:00.000Z",
        processedAt: "2026-09-25T09:00:00.000Z",
      },
    ]);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.payouts[0].paymentReference).toBe("QGR7X8Y2Z1");
    // Scoped to this creator, and newest first — a payout list is not a public
    // ledger.
    expect(mocks.payoutFindMany.mock.calls[0][0].where).toEqual({ creatorId: CREATOR });
  });
});
