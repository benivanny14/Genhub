// =============================================================================
// GENHUB - Who may watch a video
//
// This service exists because three routes answered this question three ways,
// and the difference was not a design decision — it was drift. The download
// route honoured a monthly subscription and the watch page did not, so a
// subscriber could download a creator's file but was shown a Buy button to
// stream it.
//
// The rules, asserted here:
//   free          anyone, signed in or not
//   admin         always
//   owner         always — the creator, usually via "View as viewer"
//   purchase      a LIVE access row, or a SUCCESS charge that never got one
//   subscription  an ACTIVE, unexpired subscription to that creator
//   otherwise     nothing, and the answer names no source
//
// EXPIRY, which is the case that was missing: `VideoAccess.expiresAt` exists to
// end access (null = lifetime), and the lookup used to ignore it. A expired row
// then also read as "no row at all", which is the condition the self-heal treats
// as a missing credit — so reloading after a rental ran out re-created the row
// with no expiry and made a one-day rental permanent.
//
// Prisma is mocked: no database required.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  accessFindFirst: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    videoAccess: { findFirst: mocks.accessFindFirst, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
  },
}));

import { resolveVideoEntitlement } from "@/lib/services/video-entitlement.service";

const VIDEO = { id: "row-1", price: 5000, creatorId: "creator-1" };
const VIEWER = { userId: "viewer-1", role: "VIEWER" };

/**
 * Answer the two access lookups by which question they asked.
 *
 * The service asks twice — once for live access, once for a row that has run
 * out — and the difference is entirely in the `expiresAt` clause, so the mock
 * reads the query rather than depending on call order.
 */
function setAccessRows({ live = null, expired = null }: { live?: unknown; expired?: unknown } = {}) {
  mocks.accessFindFirst.mockImplementation(
    async (args: { where?: { expiresAt?: { lte?: Date } } }) =>
      args?.where?.expiresAt?.lte ? expired : live
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAccessRows();
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.subscriptionFindFirst.mockResolvedValue(null);
  mocks.accessUpsert.mockResolvedValue({ id: "access-1" });
});

describe("free videos", () => {
  it("are entitled for a signed-out visitor, without touching the database", async () => {
    const result = await resolveVideoEntitlement({ ...VIDEO, price: 0 }, null);

    expect(result).toEqual({ entitled: true, source: "free", healed: false });
    expect(mocks.accessFindFirst).not.toHaveBeenCalled();
    expect(mocks.subscriptionFindFirst).not.toHaveBeenCalled();
  });
});

describe("a viewer with no entitlement", () => {
  it("gets nothing when nobody is signed in", async () => {
    expect(await resolveVideoEntitlement(VIDEO, null)).toEqual({
      entitled: false,
      source: null,
      healed: false,
    });
  });

  it("gets nothing when they have neither bought nor subscribed", async () => {
    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: false,
      source: null,
      healed: false,
    });
  });
});

describe("privileged viewers", () => {
  it("lets an admin watch", async () => {
    const result = await resolveVideoEntitlement(VIDEO, { userId: "a1", role: "ADMIN" });
    expect(result).toEqual({ entitled: true, source: "admin", healed: false });
  });

  it("lets the creator watch their own upload", async () => {
    const result = await resolveVideoEntitlement(VIDEO, {
      userId: "creator-1",
      role: "CREATOR",
    });
    expect(result).toEqual({ entitled: true, source: "owner", healed: false });
  });
});

describe("a purchase", () => {
  it("is an entitlement when the access row exists", async () => {
    setAccessRows({ live: { id: "access-1" } });

    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: true,
      source: "purchase",
      healed: false,
    });
  });

  // The rule the schema states (null = lifetime) turned into a real lookup.
  it("asks for a row that is either lifetime or not yet expired", async () => {
    await resolveVideoEntitlement(VIDEO, VIEWER);

    const where = mocks.accessFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ viewerId: "viewer-1", videoId: "row-1" });
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ expiresAt: null });
    expect(where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
  });

  it("ends when the access row has expired", async () => {
    // A rental that ran out, with the charge that bought it still on record —
    // the tempting thing to do with that charge is call it a purchase.
    setAccessRows({ live: null, expired: { id: "access-expired" } });
    mocks.transactionFindFirst.mockResolvedValue({ id: "txn-1" });

    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: false,
      source: null,
      healed: false,
    });
  });

  it("does not resurrect an expired row as a permanent purchase", async () => {
    setAccessRows({ live: null, expired: { id: "access-expired" } });
    mocks.transactionFindFirst.mockResolvedValue({ id: "txn-1" });

    await resolveVideoEntitlement(VIDEO, VIEWER);

    // Re-creating the row here would clear `expiresAt` and turn a 24-hour rental
    // into a lifetime one, so the self-heal must stay off for an expired row.
    expect(mocks.accessUpsert).not.toHaveBeenCalled();
  });

  it("reports the expiry it was given rather than trusting caller order", async () => {
    // Same mocks, but the expired lookup answers first in this fake: reading the
    // QUERY (not the call index) is what makes the two distinguishable.
    setAccessRows({ live: { id: "access-live" }, expired: { id: "access-expired" } });

    expect((await resolveVideoEntitlement(VIDEO, VIEWER)).entitled).toBe(true);
  });

  // Self-heal: a SUCCESS charge with no access row must never lock a paying
  // customer out of what they bought (legacy rows, an interrupted credit).
  it("is repaired when the charge succeeded but the access row is missing", async () => {
    mocks.transactionFindFirst.mockResolvedValue({ id: "txn-1" });

    const result = await resolveVideoEntitlement(VIDEO, VIEWER);

    expect(result).toEqual({ entitled: true, source: "purchase", healed: true });
    expect(mocks.accessUpsert).toHaveBeenCalledWith({
      where: { viewerId_videoId: { viewerId: "viewer-1", videoId: "row-1" } },
      create: { viewerId: "viewer-1", videoId: "row-1" },
      update: {},
    });
  });

  it("does not create an access row when there is nothing to heal", async () => {
    await resolveVideoEntitlement(VIDEO, VIEWER);
    expect(mocks.accessUpsert).not.toHaveBeenCalled();
  });

  it("only counts a charge that actually succeeded", async () => {
    await resolveVideoEntitlement(VIDEO, VIEWER);

    const where = mocks.transactionFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "viewer-1",
      videoId: "row-1",
      type: "PPV_PURCHASE",
      status: "SUCCESS",
    });
  });
});

describe("a subscription", () => {
  // The behaviour that was missing: paying the creator monthly is a way to
  // WATCH, not only a way to download.
  it("entitles the viewer to the creator's paid scenes", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });

    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: true,
      source: "subscription",
      healed: false,
    });
  });

  it("only counts a subscription to THIS creator, still active and unexpired", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(null);
    await resolveVideoEntitlement(VIDEO, VIEWER);

    const where = mocks.subscriptionFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      viewerId: "viewer-1",
      creatorId: "creator-1",
      isActive: true,
    });
    // An expiry in the future, not merely a flag: a cancelled subscription keeps
    // its row until the paid period runs out.
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(where.expiresAt.gt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("loses to a purchase, so the UI can say \"Purchased\" about a scene they own", async () => {
    setAccessRows({ live: { id: "access-1" } });
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });

    expect((await resolveVideoEntitlement(VIDEO, VIEWER)).source).toBe("purchase");
  });

  it("still entitles a subscriber whose rental ran out", async () => {
    // Both are true at once: the 24-hour pass expired, the monthly one did not.
    // Refusing here would sell a subscriber a scene they are already paying for.
    setAccessRows({ live: null, expired: { id: "access-expired" } });
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });

    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: true,
      source: "subscription",
      healed: false,
    });
  });

  it("does not entitle a signed-out visitor", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });
    expect((await resolveVideoEntitlement(VIDEO, null)).entitled).toBe(false);
  });
});
