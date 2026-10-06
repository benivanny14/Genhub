// =============================================================================
// GENHUB - Paid-message earnings for the creator dashboard
//
// Every message is a payment, so the dashboard has to answer: how much has come
// in from the inbox, and is any of it waiting? There is no holding period any
// more — a paid message is withdrawable the moment it settles — so the card
// reports everything as cleared, and this file pins that.
//
// The rules pinned here:
//   * The figures come from the same ledger every other earnings card reads:
//     SUCCESS transactions with a `creatorCut`. A refunded or pending charge is
//     not income and must not be counted.
//   * Only messages count. /api/tips writes the same TIP transaction type for a
//     plain tip, so the filter has to name `metadata.method = "pay_message"` —
//     without it, every tip a creator ever received would inflate this card.
//   * Nothing is held: `held` is 0, `cleared` is all of `earned`, and each row's
//     `clearsAt` is when it settled.
//
// Prisma is mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  transactionAggregate: vi.fn(),
  transactionGroupBy: vi.fn(),
  messageFindMany: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: {
      aggregate: (...a: unknown[]) => mocks.transactionAggregate(...a),
      groupBy: (...a: unknown[]) => mocks.transactionGroupBy(...a),
    },
    payMessage: { findMany: (...a: unknown[]) => mocks.messageFindMany(...a) },
    user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) },
  },
}));

import { getChatRevenue, getPaidMessageEarnings } from "@/lib/services/paid-message.service";

const DAY = 86_400_000;
const CREATOR = "creator-1";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transactionAggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { creatorCut: null },
  });
  mocks.messageFindMany.mockResolvedValue([]);
  mocks.transactionGroupBy.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});

describe("what the card counts", () => {
  it("counts paid messages, not tips", async () => {
    mocks.transactionAggregate.mockResolvedValue({
      _count: { _all: 4 },
      // `amount` is what fans paid; `creatorCut` is the creator's 70% of it.
      _sum: { creatorCut: 6000, amount: 8571 },
    });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.messages).toBe(4);
    expect(result.gross).toBe(8571);
    expect(result.earned).toBe(6000);

    const lifetime = mocks.transactionAggregate.mock.calls[0][0].where;
    expect(lifetime).toMatchObject({
      creatorId: CREATOR,
      status: "SUCCESS",
      creatorCut: { not: null },
      // The exclusions that matter: a pending or refunded charge is not income,
      // and a plain tip is not a message.
      metadata: { path: ["method"], equals: "pay_message" },
    });
  });

  it("reports nothing held — a message is available as soon as it settles", async () => {
    mocks.transactionAggregate.mockResolvedValue({
      _count: { _all: 4 },
      _sum: { creatorCut: 6000, amount: 8571 },
    });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.held).toBe(0);
    expect(result.heldMessages).toBe(0);
    expect(result.cleared).toBe(6000);
    expect(result.nextReleaseAt).toBeNull();
  });

  it("reports zeros for a creator nobody has messaged", async () => {
    const result = await getPaidMessageEarnings(CREATOR);

    expect(result).toEqual({
      messages: 0,
      gross: 0,
      earned: 0,
      heldMessages: 0,
      held: 0,
      cleared: 0,
      nextReleaseAt: null,
      recent: [],
    });
  });

  it("reads only the lifetime and the recent messages", async () => {
    await getPaidMessageEarnings(CREATOR);

    // One aggregate (lifetime) and the recent list. The old design read twice —
    // a lifetime and a "still held" cut — and that second read is gone.
    expect(mocks.transactionAggregate).toHaveBeenCalledTimes(1);
  });
});

describe("the recent list", () => {
  it("asks only for paid messages received, newest first", async () => {
    await getPaidMessageEarnings(CREATOR);

    const args = mocks.messageFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ receiverId: CREATOR, amount: { gt: 0 } });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(5);
  });

  it("marks every message cleared, dated when it settled", async () => {
    const fresh = new Date(Date.now() - 2 * DAY);
    mocks.messageFindMany.mockResolvedValue([
      { id: "m-new", amount: 1000, createdAt: fresh, sender: { id: "v1", displayName: "Asha", avatarUrl: null } },
    ]);

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.recent[0]).toMatchObject({
      id: "m-new",
      amount: 1000,
      // The row shows what the creator got, so it has to be the ledger's half of
      // what the fan paid — not the gross, which the row shows beside it.
      earned: 700,
      held: false,
      clearsAt: fresh.toISOString(),
      sender: { displayName: "Asha" },
    });
  });
});

// -----------------------------------------------------------------------------
// The platform-wide view, which is the same ledger grouped by creator.
// -----------------------------------------------------------------------------
describe("chat revenue per creator", () => {
  const row = (id: string, earned: number, messages: number) => ({
    creatorId: id,
    _sum: { creatorCut: earned },
    _count: { _all: messages },
  });

  it("counts every creator with chat income while listing only the top earners", async () => {
    mocks.transactionGroupBy.mockResolvedValueOnce([
      row("c-mid", 500, 2),
      row("c-top", 900, 3),
      row("c-low", 100, 1),
    ]);
    mocks.transactionAggregate.mockResolvedValue({
      _sum: { creatorCut: 1500, amount: 2000, platformFee: 500 },
      _count: { _all: 6 },
    });
    mocks.userFindMany.mockResolvedValue([
      { id: "c-top", displayName: "Asha", avatarUrl: null },
      { id: "c-mid", displayName: "Neema", avatarUrl: null },
    ]);

    const result = await getChatRevenue(2);

    // Totals are platform-wide, so the cap on the list cannot change them.
    expect(result.totals).toEqual({
      creators: 3,
      messages: 6,
      gross: 2000,
      earned: 1500,
      platformFee: 500,
      heldMessages: 0,
      held: 0,
    });
    expect(result.truncated).toBe(true);
    expect(result.creators.map((c) => c.creatorId)).toEqual(["c-top", "c-mid"]);
    expect(result.creators[0]).toMatchObject({ displayName: "Asha", earned: 900, messages: 3 });
    expect(result.creators[1]).toMatchObject({ earned: 500, held: 0, heldMessages: 0 });
  });

  it("reads the same ledger the creator card reads", async () => {
    mocks.transactionGroupBy.mockResolvedValueOnce([row("c1", 500, 1)]);

    await getChatRevenue();

    expect(mocks.transactionGroupBy.mock.calls[0][0].where).toEqual({
      status: "SUCCESS",
      creatorCut: { not: null },
      metadata: { path: ["method"], equals: "pay_message" },
      // A message paid to an ordinary account never reaches a creator balance.
      creatorId: { not: null },
    });
  });

  it("asks nothing else when no message has ever been paid for", async () => {
    const result = await getChatRevenue();

    expect(result).toEqual({
      totals: {
        creators: 0,
        messages: 0,
        gross: 0,
        earned: 0,
        platformFee: 0,
        heldMessages: 0,
        held: 0,
      },
      creators: [],
      truncated: false,
    });
    expect(mocks.transactionAggregate).not.toHaveBeenCalled();
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("names nobody when the account behind a ledger row is gone", async () => {
    mocks.transactionGroupBy.mockResolvedValueOnce([row("c-gone", 500, 1)]);

    const result = await getChatRevenue();

    expect(result.creators[0]).toMatchObject({ displayName: null, avatarUrl: null });
  });
});
