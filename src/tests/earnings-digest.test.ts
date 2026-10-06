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
// The digest is a summary now, not a holding-period explainer: everything earned
// in the week shows up as earnings, with no "cleared" subset.
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
    locale: "sw",
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
  it("sends one digest with the week's earnings and what is available", async () => {
    const result = await sendDueEarningsDigests(NOW);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0, errors: 0 });
    expect(mocks.sendDigest).toHaveBeenCalledTimes(1);
    const params = mocks.sendDigest.mock.calls[0][0];
    expect(params.to).toBe("creator@genhub.test");
    // Everything earned in the last seven days is income; there is no holding
    // period any more, so there is no "cleared" subset of it.
    expect(params.earnedThisWeek).toBe(3_500);
    expect(params.available).toBe(12_000);
    expect(params.totalEarned).toBe(19_000);
    expect(params.minWithdrawal).toBe(config.business.minPayoutAmount);
    // The creator's own language is carried through, so the summary arrives in
    // the language they read.
    expect(params.locale).toBe("sw");
  });

  it("reads the week from the last seven days, not a holding window", async () => {
    await sendDueEarningsDigests(NOW);

    const where = mocks.txAggregate.mock.calls[0][0].where;
    expect(where.creatorId).toBe("creator-1");
    expect(where.status).toBe("SUCCESS");
    const since = where.createdAt.gt as Date;
    expect(NOW.getTime() - since.getTime()).toBe(7 * DAY);
    // No upper bound any more: the old second query cut at "older than 14 days",
    // which no longer means anything.
    expect(where.createdAt.lte).toBeUndefined();
  });

  it("only considers creators who have not opted out", async () => {
    await sendDueEarningsDigests(NOW);

    const where = mocks.userFindMany.mock.calls[0][0].where;
    expect(where.role).toBe("CREATOR");
    expect(where.earningsDigestEnabled).toBe(true);
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

  it("emails a creator with a withdrawable balance even in a quiet week", async () => {
    // Nothing was earned, but there is money to withdraw: that is worth saying,
    // and the alternative is never telling them the balance is there.
    mocks.txAggregate.mockResolvedValue({ _sum: { creatorCut: 0 } });

    const result = await sendDueEarningsDigests(NOW);

    expect(result.sent).toBe(1);
    const params = mocks.sendDigest.mock.calls[0][0];
    expect(params.earnedThisWeek).toBe(0);
    expect(params.available).toBe(12_000);
  });
});
