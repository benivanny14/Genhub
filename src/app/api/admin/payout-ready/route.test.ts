// =============================================================================
// GENHUB - GET /api/admin/payout-ready
//
// The list the admins are pushed to when a creator holds money. Three things
// must hold or the page lies:
//
//   1. A creator who reached the TZS 30,000 floor appears and reads as ready.
//   2. A creator BELOW the floor appears too — separately counted, marked
//      `belowFloor` and unable to withdraw — because an empty list and a total of
//      zero is not the truth about money the platform is holding for them. That
//      row is where the admin allows a smaller withdrawal.
//   3. A frozen account reads as unable to withdraw, so an operator does not
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
  gatewayFloor: vi.fn(() => 30_000),
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

// The only thing this route needs from the payout service is the number the
// gateway will actually send, so the gateway itself stays out of this file.
vi.mock("@/lib/services/payout-disbursement.service", () => ({
  gatewayMinPayout: () => mocks.gatewayFloor(),
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

  it("lists everyone holding money — below the floor included", async () => {
    await get();

    const where = mocks.balanceFindMany.mock.calls[0][0].where;
    // One condition, and it is the only honest one: a balance above zero. The
    // old TZS 30,000 cut is applied when the row is built (atMinimum /
    // belowFloor) so the list can report both groups instead of hiding one.
    expect(where).toEqual({ availableBalance: { gt: 0 } });
  });

  it("shows a creator below the floor as money held, not as absent", async () => {
    mocks.balanceFindMany.mockResolvedValue([
      row({ availableBalance: 2_450, totalEarned: 2_450 }),
    ]);

    const body = await (await get()).json();

    const creator = body.data.creators[0];
    expect(creator.atMinimum).toBe(false);
    expect(creator.belowFloor).toBe(true);
    expect(creator.canWithdraw).toBe(false);
    // The totals have to agree with the row: nothing is "ready", but the
    // platform is still holding TZS 2,450 for somebody.
    expect(body.data.totals.readyCount).toBe(0);
    expect(body.data.totals.readyAmount).toBe(0);
    expect(body.data.totals.belowFloorCount).toBe(1);
    expect(body.data.totals.belowFloorAmount).toBe(2_450);
    expect(body.data.totals.totalCount).toBe(1);
    expect(body.data.totals.totalAmount).toBe(2_450);
  });

  it("sends the gateway's floor too, which no waiver can lift", async () => {
    // Two different limits travel with this list. `minimum` is Genhub's, the one
    // WAIVE_PAYOUT_MINIMUM lets an admin lift for one creator; `gatewayMinimum`
    // is the gateway's own, and allowing a small withdrawal does not make it
    // sendable. The tab that offers the waiver quotes the second one, so it has
    // to arrive from the server rather than be repeated in the screen.
    mocks.gatewayFloor.mockReturnValue(45_000);

    const body = await (await get()).json();

    expect(body.data.minimum).toBe(30_000);
    expect(body.data.gatewayMinimum).toBe(45_000);
  });

  it("stops calling a waived account below the floor \"below floor\"", async () => {
    mocks.balanceFindMany.mockResolvedValue([
      row({
        availableBalance: 2_450,
        creator: { ...row().creator, payoutMinimumWaived: true },
      }),
    ]);

    const body = await (await get()).json();

    expect(body.data.creators[0].belowFloor).toBe(false);
    expect(body.data.creators[0].canWithdraw).toBe(true);
    expect(body.data.totals.belowFloorCount).toBe(0);
  });

  it("counts the frozen accounts it is holding money for", async () => {
    mocks.balanceFindMany.mockResolvedValue([
      row({
        creator: {
          ...row().creator,
          payoutFrozenUntil: new Date(Date.now() + 86_400_000),
        },
      }),
    ]);

    const body = await (await get()).json();

    expect(body.data.totals.frozenCount).toBe(1);
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
