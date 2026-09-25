// =============================================================================
// GENHUB - Paid-message earnings for the creator dashboard
//
// Every message is now a payment, so the dashboard has to answer three questions
// a single number cannot: how much has come in from the inbox, how much of it is
// still inside the 14-day holding, and when does the held part actually land.
// Getting the split wrong is not cosmetic — it tells a creator they can pay out
// money the release job will not move.
//
// The rules pinned here:
//   * The figures come from the same ledger the release job reads: SUCCESS
//     transactions with a `creatorCut`. A refunded or pending charge is not
//     income and must not be counted.
//   * Only messages count. /api/tips writes the same TIP transaction type for a
//     plain tip, so the filter has to name `metadata.method = "pay_message"` —
//     without it, every tip a creator ever received would inflate this card.
//   * "Held" is exactly the part younger than the holding period, and it must be
//     the same length of time the release job uses.
//   * The release date the card promises is the oldest held message's maturity,
//     because that is the one that frees up first.
//
// Prisma and config are mocked; no database, no clock surprises.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  transactionAggregate: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionGroupBy: vi.fn(),
  messageFindMany: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: {
      aggregate: (...a: unknown[]) => mocks.transactionAggregate(...a),
      findFirst: (...a: unknown[]) => mocks.transactionFindFirst(...a),
      groupBy: (...a: unknown[]) => mocks.transactionGroupBy(...a),
    },
    payMessage: { findMany: (...a: unknown[]) => mocks.messageFindMany(...a) },
    user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) },
  },
}));

vi.mock("@/lib/config", () => ({
  default: { business: { holdingPeriodDays: 14 } },
}));

import { getChatRevenue, getPaidMessageEarnings } from "@/lib/services/paid-message.service";

const DAY = 86_400_000;
const CREATOR = "creator-1";

/** The two `transaction.aggregate` calls: lifetime first, then the held part. */
function ledger(lifetime: { count: number; sum: number | null }, held: { count: number; sum: number | null }) {
  mocks.transactionAggregate
    .mockResolvedValueOnce({ _count: { _all: lifetime.count }, _sum: { creatorCut: lifetime.sum } })
    .mockResolvedValueOnce({ _count: { _all: held.count }, _sum: { creatorCut: held.sum } });
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a test that queues two `mockResolvedValueOnce`
  // answers leaves any it did not consume behind, and the next test's first read
  // would quietly receive them.
  vi.resetAllMocks();
  mocks.transactionAggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { creatorCut: null },
  });
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.messageFindMany.mockResolvedValue([]);
  mocks.transactionGroupBy.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});

describe("what the card counts", () => {
  it("counts paid messages, not tips", async () => {
    ledger({ count: 4, sum: 6000 }, { count: 2, sum: 2500 });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.messages).toBe(4);
    expect(result.earned).toBe(6000);
    expect(result.held).toBe(2500);
    expect(result.heldMessages).toBe(2);
    expect(result.cleared).toBe(3500);

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

  it("splits at the same 14 days the release job uses", async () => {
    const before = Date.now();

    await getPaidMessageEarnings(CREATOR);

    const held = mocks.transactionAggregate.mock.calls[1][0].where;
    expect(held.creatorId).toBe(CREATOR);
    expect(held.metadata).toEqual({ path: ["method"], equals: "pay_message" });

    const cutoff = held.createdAt.gt as Date;
    const heldForDays = (before - cutoff.getTime()) / DAY;
    expect(heldForDays).toBeGreaterThan(13.99);
    expect(heldForDays).toBeLessThan(14.01);
  });

  it("reports zeros for a creator nobody has messaged", async () => {
    const result = await getPaidMessageEarnings(CREATOR);

    expect(result).toEqual({
      messages: 0,
      earned: 0,
      heldMessages: 0,
      held: 0,
      cleared: 0,
      nextReleaseAt: null,
      recent: [],
    });
  });

  it("never reports a negative cleared amount if the ledger disagrees", async () => {
    // Cannot happen through the routes, but a negative "cleared" would render as
    // a payout a creator can never request.
    ledger({ count: 1, sum: 1000 }, { count: 2, sum: 1500 });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.cleared).toBe(0);
  });
});

describe("the release date it promises", () => {
  it("is the oldest held message's maturity", async () => {
    const oldest = new Date(Date.now() - 3 * DAY);
    ledger({ count: 3, sum: 3000 }, { count: 3, sum: 3000 });
    mocks.transactionFindFirst.mockResolvedValue({ createdAt: oldest });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.nextReleaseAt).toBe(new Date(oldest.getTime() + 14 * DAY).toISOString());
    // The oldest, not the newest: an id-ordered or descending read would promise
    // a date further out than the money actually lands.
    expect(mocks.transactionFindFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: "asc" });
  });

  it("is absent when nothing is held", async () => {
    ledger({ count: 9, sum: 9000 }, { count: 0, sum: 0 });

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.nextReleaseAt).toBeNull();
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

  it("marks each message held or cleared against the same 14 days", async () => {
    const fresh = new Date(Date.now() - 2 * DAY);
    const old = new Date(Date.now() - 20 * DAY);
    mocks.messageFindMany.mockResolvedValue([
      { id: "m-new", amount: 1000, createdAt: fresh, sender: { id: "v1", displayName: "Asha", avatarUrl: null } },
      { id: "m-old", amount: 500, createdAt: old, sender: { id: "v2", displayName: null, avatarUrl: null } },
    ]);

    const result = await getPaidMessageEarnings(CREATOR);

    expect(result.recent[0]).toMatchObject({
      id: "m-new",
      amount: 1000,
      held: true,
      clearsAt: new Date(fresh.getTime() + 14 * DAY).toISOString(),
      sender: { displayName: "Asha" },
    });
    expect(result.recent[1]).toMatchObject({ id: "m-old", held: false });
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

  /**
   * The two platform-wide aggregates of the pair: the held totals are the ones
   * asking for `createdAt`, so the stub answers by shape instead of by call order
   * — order would break the moment one query joins a Promise.all earlier.
   */
  function platformTotals(
    lifetime: { amount: number; count: number },
    held: { amount: number; count: number }
  ) {
    mocks.transactionAggregate.mockImplementation(
      (args: { where: { createdAt?: unknown } }) =>
        Promise.resolve(
          args.where.createdAt
            ? { _sum: { creatorCut: held.amount }, _count: { _all: held.count } }
            : { _sum: { creatorCut: lifetime.amount }, _count: { _all: lifetime.count } }
        )
    );
  }

  it("counts every creator with chat income while listing only the top earners", async () => {
    mocks.transactionGroupBy.mockResolvedValueOnce([
      row("c-mid", 500, 2),
      row("c-top", 900, 3),
      row("c-low", 100, 1),
    ]);
    platformTotals({ amount: 1500, count: 6 }, { amount: 700, count: 2 });
    mocks.userFindMany.mockResolvedValue([
      { id: "c-top", displayName: "Asha", avatarUrl: null },
      { id: "c-mid", displayName: "Neema", avatarUrl: null },
    ]);

    const result = await getChatRevenue(2);

    // Totals are platform-wide, so the cap on the list cannot change them.
    expect(result.totals).toEqual({
      creators: 3,
      messages: 6,
      earned: 1500,
      heldMessages: 2,
      held: 700,
    });
    expect(result.truncated).toBe(true);
    expect(result.creators.map((c) => c.creatorId)).toEqual(["c-top", "c-mid"]);
    expect(result.creators[0]).toMatchObject({ displayName: "Asha", earned: 900, messages: 3 });
    // Nobody returned a held row for c-mid, so its held part is zero rather than
    // the platform total leaking into it.
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

  it("splits the holding per listed creator, against the same 14 days", async () => {
    const before = Date.now();
    mocks.transactionGroupBy
      .mockResolvedValueOnce([row("c1", 500, 1)])
      .mockResolvedValueOnce([
        { creatorId: "c1", _sum: { creatorCut: 500 }, _count: { _all: 1 } },
      ]);

    const result = await getChatRevenue();

    const heldQuery = mocks.transactionGroupBy.mock.calls[1][0];
    expect(heldQuery.where.creatorId).toEqual({ in: ["c1"] });
    const heldForDays = (before - (heldQuery.where.createdAt.gt as Date).getTime()) / DAY;
    expect(heldForDays).toBeGreaterThan(13.99);
    expect(heldForDays).toBeLessThan(14.01);
    expect(result.creators[0]).toMatchObject({ held: 500, heldMessages: 1 });
  });

  it("takes the platform-wide held total from the whole ledger", async () => {
    mocks.transactionGroupBy.mockResolvedValueOnce([row("c1", 500, 1)]);
    platformTotals({ amount: 500, count: 1 }, { amount: 500, count: 1 });

    const result = await getChatRevenue();

    const heldAggregate = mocks.transactionAggregate.mock.calls.find(
      (call) => call[0].where.createdAt
    );
    expect(heldAggregate?.[0].where.creatorId).toEqual({ not: null });
    expect(result.totals.held).toBe(500);
  });

  it("asks nothing else when no message has ever been paid for", async () => {
    const result = await getChatRevenue();

    expect(result).toEqual({
      totals: { creators: 0, messages: 0, earned: 0, heldMessages: 0, held: 0 },
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
