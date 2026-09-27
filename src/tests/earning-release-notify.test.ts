// =============================================================================
// GENHUB - Telling a creator their money left the 14-day holding
//
// `releaseMatureEarnings` moves pending -> available. To the creator this is
// invisible: the number on their dashboard simply changes, and if it does not
// (because nothing has matured yet) it looks like the platform is sitting on the
// money. A notification at the exact moment of release is what makes the 14-day
// rule legible instead of a silent wait.
//
// Pinned here: a release notifies ONCE with the amount that actually moved, and
// a run that moves nothing notifies nobody — otherwise a job that runs on every
// dashboard load would spam a notification every time the page is opened.
//
// Prisma is mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  balanceFindMany: vi.fn(),
  txAggregate: vi.fn(),
  balanceUpdateMany: vi.fn(),
  notificationCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    creatorBalance: {
      findMany: (...a: unknown[]) => mocks.balanceFindMany(...a),
      updateMany: (...a: unknown[]) => mocks.balanceUpdateMany(...a),
    },
    transaction: { aggregate: (...a: unknown[]) => mocks.txAggregate(...a) },
    notification: { create: (...a: unknown[]) => mocks.notificationCreate(...a) },
  },
}));

import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

const CREATOR = "creator-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.balanceFindMany.mockResolvedValue([
    { creatorId: CREATOR, pendingBalance: 5000, releasedTotal: 0 },
  ]);
  mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 5000 } });
  mocks.balanceUpdateMany.mockResolvedValue({ count: 1 });
  mocks.notificationCreate.mockResolvedValue({});
});

describe("releaseMatureEarnings notification", () => {
  it("notifies the creator with the amount that just cleared", async () => {
    const result = await releaseMatureEarnings();

    expect(result.released).toBe(5000);
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    const data = mocks.notificationCreate.mock.calls[0][0].data;
    expect(data.userId).toBe(CREATOR);
    expect(data.message).toContain("5,000");
    expect(data.link).toBe("/creator");
  });

  it("says nothing when nothing matured", async () => {
    // delta <= 0: every charge is still inside the window.
    mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 0 } });

    const result = await releaseMatureEarnings();

    expect(result.released).toBe(0);
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it("says nothing when another run already took the release", async () => {
    // The optimistic lock lost the race: this run moved no money, so it must not
    // claim it did.
    mocks.balanceUpdateMany.mockResolvedValue({ count: 0 });

    const result = await releaseMatureEarnings();

    expect(result.released).toBe(0);
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it("still releases the money if the notification itself fails", async () => {
    // A notification must never undo a release that already happened.
    mocks.notificationCreate.mockRejectedValue(new Error("notification down"));

    const result = await releaseMatureEarnings();

    expect(result.released).toBe(5000);
    expect(result.creators).toBe(1);
  });
});
