// =============================================================================
// GENHUB - The weekly creator earnings digest
//
// This job runs on the cron supervisor's poke, which is hours apart and never
// exactly seven days, so the week is enforced inside the service. The tests here
// pin the two ways that could go wrong and would be invisible until a creator
// complained (or was spammed):
//
//   1. a creator who was told last week is not told again this week;
//   2. the week is claimed before the send, so two pokes cannot both send — and
//      a creator with nothing to report does not burn the week either.
//
// Prisma and the mailer are mocked; no database, no email.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  userUpdateMany: vi.fn(),
  txAggregate: vi.fn(),
  txFindFirst: vi.fn(),
  sendDigest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findMany: (...a: unknown[]) => mocks.userFindMany(...a),
      updateMany: (...a: unknown[]) => mocks.userUpdateMany(...a),
    },
    transaction: {
      aggregate: (...a: unknown[]) => mocks.txAggregate(...a),
      findFirst: (...a: unknown[]) => mocks.txFindFirst(...a),
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendEarningsDigestEmail: (...a: unknown[]) => mocks.sendDigest(...a),
}));

import config from "@/lib/config";
import { sendDueEarningsDigests } from "@/lib/services/earnings-digest.service";

const DAY = 86_400_000;
const NOW = new Date("2026-09-27T08:00:00.000Z");

function creator(over: Record<string, unknown> = {}) {
  return {
    id: "creator-1",
    email: "creator@genhub.test",
    displayName: "Amina",
    lastEarningsDigestAt: null,
    creatorBalance: {
      pendingBalance: 7_000,
      availableBalance: 12_000,
      totalEarned: 19_000,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindMany.mockResolvedValue([creator()]);
  mocks.userUpdateMany.mockResolvedValue({ count: 1 });
  mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 3_500 } });
  mocks.txFindFirst.mockResolvedValue(null);
  mocks.sendDigest.mockResolvedValue({ sent: true, transport: "console" });
});

describe("sendDueEarningsDigests", () => {
  it("sends one digest with what cleared and what is still held", async () => {
    const result = await sendDueEarningsDigests(NOW);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0, errors: 0 });
    expect(mocks.sendDigest).toHaveBeenCalledTimes(1);
    const params = mocks.sendDigest.mock.calls[0][0];
    expect(params.to).toBe("creator@genhub.test");
    expect(params.clearedThisWeek).toBe(3_500);
    expect(params.pending).toBe(7_000);
    expect(params.available).toBe(12_000);
    expect(params.holdingDays).toBe(config.business.holdingPeriodDays);
  });

  it("claims the week before it sends, so two pokes cannot both email", async () => {
    await sendDueEarningsDigests(NOW);

    const claim = mocks.userUpdateMany.mock.calls[0][0];
    expect(claim.where.id).toBe("creator-1");
    // The claim is conditional on the week being over — that is the guard.
    expect(claim.where.OR).toBeTruthy();
    expect(mocks.userUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendDigest.mock.invocationCallOrder[0]
    );
  });

  it("keeps quiet when the claim is lost to another run", async () => {
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });

    const result = await sendDueEarningsDigests(NOW);

    expect(result.sent).toBe(0);
    expect(mocks.sendDigest).not.toHaveBeenCalled();
  });

  it("does not email a creator who was already told this week", async () => {
    mocks.userFindMany.mockResolvedValue([
      creator({ lastEarningsDigestAt: new Date(NOW.getTime() - 2 * DAY) }),
    ]);

    const result = await sendDueEarningsDigests(NOW);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.sendDigest).not.toHaveBeenCalled();
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("emails again once a full week has passed", async () => {
    mocks.userFindMany.mockResolvedValue([
      creator({ lastEarningsDigestAt: new Date(NOW.getTime() - 8 * DAY) }),
    ]);

    const result = await sendDueEarningsDigests(NOW);

    expect(result.sent).toBe(1);
  });

  it("stays quiet, and does not consume the week, for a creator with nothing to report", async () => {
    mocks.userFindMany.mockResolvedValue([
      creator({
        creatorBalance: {
          pendingBalance: 0,
          availableBalance: 0,
          totalEarned: 0,
        },
      }),
    ]);
    mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 0 } });

    const result = await sendDueEarningsDigests(NOW);

    expect(result.sent).toBe(0);
    expect(mocks.sendDigest).not.toHaveBeenCalled();
    // Never claimed, so tomorrow's first sale is not locked out of a digest for
    // a week.
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("dates the next release from the oldest still-held sale", async () => {
    const soldAt = new Date(NOW.getTime() - 3 * DAY);
    mocks.txFindFirst.mockResolvedValue({ createdAt: soldAt });

    await sendDueEarningsDigests(NOW);

    const params = mocks.sendDigest.mock.calls[0][0];
    const expected = new Date(
      soldAt.getTime() + config.business.holdingPeriodDays * DAY
    ).toISOString();
    expect(params.nextReleaseAt).toBe(expected);
  });
});
