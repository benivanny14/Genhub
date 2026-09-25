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
//   purchase      an access row, or a SUCCESS charge that never got one
//   subscription  an ACTIVE, unexpired subscription to that creator
//   otherwise     nothing, and the answer names no source
//
// Prisma is mocked: no database required.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  accessFindUnique: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    videoAccess: { findUnique: mocks.accessFindUnique, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
  },
}));

import { resolveVideoEntitlement } from "@/lib/services/video-entitlement.service";

const VIDEO = { id: "row-1", price: 5000, creatorId: "creator-1" };
const VIEWER = { userId: "viewer-1", role: "VIEWER" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accessFindUnique.mockResolvedValue(null);
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.subscriptionFindFirst.mockResolvedValue(null);
  mocks.accessUpsert.mockResolvedValue({ id: "access-1" });
});

describe("free videos", () => {
  it("are entitled for a signed-out visitor, without touching the database", async () => {
    const result = await resolveVideoEntitlement({ ...VIDEO, price: 0 }, null);

    expect(result).toEqual({ entitled: true, source: "free", healed: false });
    expect(mocks.accessFindUnique).not.toHaveBeenCalled();
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
    mocks.accessFindUnique.mockResolvedValue({ id: "access-1" });

    expect(await resolveVideoEntitlement(VIDEO, VIEWER)).toEqual({
      entitled: true,
      source: "purchase",
      healed: false,
    });
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
    mocks.accessFindUnique.mockResolvedValue({ id: "access-1" });
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });

    expect((await resolveVideoEntitlement(VIDEO, VIEWER)).source).toBe("purchase");
  });

  it("does not entitle a signed-out visitor", async () => {
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });
    expect((await resolveVideoEntitlement(VIDEO, null)).entitled).toBe(false);
  });
});
