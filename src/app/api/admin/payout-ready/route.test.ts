// =============================================================================
// GENHUB - GET /api/admin/payout-ready
//
// The list the admins are pushed to when a creator can withdraw. Two things must
// hold or the page lies:
//
//   1. A creator who reached the TZS 30,000 floor appears, and nobody below it
//      does — unless an admin has waived the floor for them, in which case they
//      can withdraw and must be listed too.
//   2. A frozen account reads as unable to withdraw, so an operator does not
//      approve a payout the platform has paused.
//
// Prisma and auth are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  balanceFindMany: vi.fn(),
  payoutGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    creatorBalance: { findMany: (...a: unknown[]) => mocks.balanceFindMany(...a) },
    payoutRequest: { groupBy: (...a: unknown[]) => mocks.payoutGroupBy(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: () => mocks.requireRole(),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

import { GET } from "./route";

function row(over: Record<string, unknown> = {}) {
  return {
    creatorId: "creator-1",
    availableBalance: 40_000,
    totalEarned: 120_000,
    creator: {
      id: "creator-1",
      displayName: "Amina",
      email: "amina@genhub.test",
      avatarUrl: null,
      role: "CREATOR",
      isVerified: true,
      kycStatus: "APPROVED",
      isBanned: false,
      payoutFrozenUntil: null,
      payoutFrozenReason: null,
      payoutMinimumWaived: false,
    },
    ...over,
  };
}

function get() {
  return GET(new NextRequest("https://app.test/api/admin/payout-ready"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.balanceFindMany.mockResolvedValue([]);
  mocks.payoutGroupBy.mockResolvedValue([]);
});

describe("GET /api/admin/payout-ready", () => {
  it("lists a creator at the floor as ready", async () => {
    mocks.balanceFindMany.mockResolvedValue([row()]);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    const creator = body.data.creators[0];
    expect(creator.atMinimum).toBe(true);
    expect(creator.canWithdraw).toBe(true);
    expect(body.data.totals.readyCount).toBe(1);
    expect(body.data.totals.readyAmount).toBe(40_000);
  });

  it("asks for the threshold, and for a waived account below it", async () => {
    await get();

    const where = mocks.balanceFindMany.mock.calls[0][0].where;
    // Both branches are the reason the list can be trusted: someone at the floor
    // and nobody else — except a creator an admin let withdraw below it.
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ availableBalance: { gte: 30_000 } });
    expect(where.OR[1]).toMatchObject({
      availableBalance: { gt: 0 },
      creator: { payoutMinimumWaived: true },
    });
  });

  it("marks a frozen creator as unable to withdraw", async () => {
    mocks.balanceFindMany.mockResolvedValue([
      row({
        creator: {
          ...row().creator,
          payoutFrozenUntil: new Date(Date.now() + 86_400_000),
        },
      }),
    ]);

    const body = await (await get()).json();

    expect(body.data.creators[0].frozen).toBe(true);
    expect(body.data.creators[0].canWithdraw).toBe(false);
  });

  it("treats an expired freeze as lifted", async () => {
    mocks.balanceFindMany.mockResolvedValue([
      row({
        creator: {
          ...row().creator,
          payoutFrozenUntil: new Date(Date.now() - 86_400_000),
        },
      }),
    ]);

    const body = await (await get()).json();

    expect(body.data.creators[0].frozen).toBe(false);
    expect(body.data.creators[0].canWithdraw).toBe(true);
  });

  it("carries how many withdrawal requests are already open", async () => {
    mocks.balanceFindMany.mockResolvedValue([row()]);
    mocks.payoutGroupBy.mockResolvedValue([
      { creatorId: "creator-1", _count: { _all: 1 } },
    ]);

    const body = await (await get()).json();

    expect(body.data.creators[0].openRequests).toBe(1);
  });

  it("says how much the platform is holding for them", async () => {
    mocks.balanceFindMany.mockResolvedValue([row()]);
    mocks.payoutGroupBy.mockResolvedValue([]);

    const body = await (await get()).json();

    expect(body.data.totals.totalAmount).toBe(40_000);
    expect(body.data.minimum).toBe(30_000);
  });
});
