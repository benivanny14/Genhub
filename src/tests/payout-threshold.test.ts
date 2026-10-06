// =============================================================================
// GENHUB - Payout threshold alerts
//
// The admins are told once when a creator's withdrawable balance reaches the
// TZS 30,000 floor — not once per sale, and not again after a payout drops them
// back below it and they earn past it.
//
// The three ways this can go wrong, all pinned here:
//   1. Alerting on every credit — a creator with twenty sales over the floor
//      would produce twenty notifications, and nobody reads the twentieth.
//   2. Never clearing the marker, so a payout-and-earn-again cycle is silent.
//   3. Failing loudly. It runs after a sale has settled; a missed alert must
//      never become a failed payment.
//
// Prisma and the notifier are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  balanceFindUnique: vi.fn(),
  balanceFindMany: vi.fn(),
  balanceUpdateMany: vi.fn(),
  userFindMany: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    creatorBalance: {
      findUnique: (...a: unknown[]) => mocks.balanceFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.balanceFindMany(...a),
      updateMany: (...a: unknown[]) => mocks.balanceUpdateMany(...a),
    },
    user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) },
  },
}));

vi.mock("@/lib/services/notify.service", () => ({
  createNotification: (...a: unknown[]) => mocks.createNotification(...a),
}));

import {
  maybeNotifyAdminsPayoutReady,
  sweepPayoutReadyAlerts,
} from "@/lib/services/payout-threshold.service";

const FLOOR = 30_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindMany.mockResolvedValue([{ id: "admin-1" }]);
  mocks.balanceFindMany.mockResolvedValue([]);
  mocks.balanceUpdateMany.mockResolvedValue({ count: 1 });
  mocks.createNotification.mockResolvedValue(undefined);
});

describe("maybeNotifyAdminsPayoutReady", () => {
  it("tells the admins once when a creator crosses the floor", async () => {
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: FLOOR,
      payoutReadyNotifiedAt: null,
      creator: { displayName: "Amina", email: "amina@genhub.test" },
    });

    const announced = await maybeNotifyAdminsPayoutReady("creator-1");

    expect(announced).toBe(true);
    // The claim happens before the send, so a concurrent credit cannot also
    // announce this crossing.
    expect(mocks.balanceUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification.mock.calls[0][0]).toMatchObject({
      userId: "admin-1",
      title: expect.stringContaining("withdraw"),
    });
  });

  it("stays silent on the second sale over the floor", async () => {
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: FLOOR + 5_000,
      payoutReadyNotifiedAt: new Date(),
      creator: { displayName: "Amina", email: null },
    });

    const announced = await maybeNotifyAdminsPayoutReady("creator-1");

    expect(announced).toBe(false);
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.balanceUpdateMany).not.toHaveBeenCalled();
  });

  it("says nothing while the creator is below the floor", async () => {
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: FLOOR - 1,
      payoutReadyNotifiedAt: null,
      creator: { displayName: "Amina", email: null },
    });

    const announced = await maybeNotifyAdminsPayoutReady("creator-1");

    expect(announced).toBe(false);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("clears the marker once a payout drops them back below the floor", async () => {
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: 5_000,
      payoutReadyNotifiedAt: new Date(),
      creator: { displayName: "Amina", email: null },
    });

    await maybeNotifyAdminsPayoutReady("creator-1");

    // Cleared, so the NEXT crossing is announced again — a creator who withdraws
    // and earns back past the floor is news a second time.
    expect(mocks.balanceUpdateMany).toHaveBeenCalledWith({
      where: { creatorId: "creator-1", payoutReadyNotifiedAt: { not: null } },
      data: { payoutReadyNotifiedAt: null },
    });
  });

  it("loses the race quietly and sends nothing", async () => {
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: FLOOR,
      payoutReadyNotifiedAt: null,
      creator: { displayName: "Amina", email: null },
    });
    mocks.balanceUpdateMany.mockResolvedValue({ count: 0 });

    const announced = await maybeNotifyAdminsPayoutReady("creator-1");

    expect(announced).toBe(false);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("never throws, even when the read fails", async () => {
    mocks.balanceFindUnique.mockRejectedValue(new Error("db down"));

    // It runs after money has already moved; a broken alert must not surface as
    // a failed sale.
    await expect(maybeNotifyAdminsPayoutReady("creator-1")).resolves.toBe(false);
  });
});

describe("sweepPayoutReadyAlerts", () => {
  it("is the backstop: it announces anyone who crossed without a nudge", async () => {
    // The sweep lists the crossed creators, then reads each one in turn.
    mocks.balanceFindMany.mockResolvedValue([{ creatorId: "creator-1" }]);
    mocks.balanceFindUnique.mockResolvedValue({
      availableBalance: FLOOR,
      payoutReadyNotifiedAt: null,
      creator: { displayName: "Amina", email: null },
    });

    const result = await sweepPayoutReadyAlerts();

    expect(result.alerted).toBe(1);
    // The last updateMany clears anyone now below the floor.
    expect(result.cleared).toBe(1);
  });

  it("stays quiet when nobody crossed the floor", async () => {
    mocks.balanceFindMany.mockResolvedValue([]);
    mocks.balanceUpdateMany.mockResolvedValue({ count: 0 });

    const result = await sweepPayoutReadyAlerts();

    expect(result.alerted).toBe(0);
  });
});
