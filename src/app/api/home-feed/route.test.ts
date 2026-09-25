// =============================================================================
// GENHUB - Tests for GET /api/home-feed
// Verifies the two behaviors that are easy to regress:
//   1. cache hits short-circuit (no DB work at all)
//   2. cache misses query the DB, shape the payload and re-cache for 60s
// Prisma and Redis are mocked — no database required.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  videoFindMany: vi.fn(),
  videoGroupBy: vi.fn(),
  videoCount: vi.fn(),
  userFindMany: vi.fn(),
  userCount: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: {
      findMany: mocks.videoFindMany,
      groupBy: mocks.videoGroupBy,
      count: mocks.videoCount,
    },
    user: {
      findMany: mocks.userFindMany,
      count: mocks.userCount,
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));

import { GET } from "./route";

const NOW = Date.now();

function makeVideo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Video ${id}`,
    slug: null,
    thumbnailUrl: null,
    previewUrl: null,
    bunnyVideoId: "",
    price: 1000,
    teaserDuration: 15,
    duration: 60,
    viewsCount: 100,
    likesCount: 5,
    purchaseCount: 2,
    category: "music",
    isPremium: false,
    isFeatured: false,
    createdAt: new Date(NOW - 3_600_000),
    creator: {
      id: "c1",
      displayName: "Creator",
      avatarUrl: null,
      isVerified: false,
    },
    ...overrides,
  };
}

function primeDb() {
  const featured = [makeVideo("v-featured", { isFeatured: true })];
  const row = [makeVideo("v1"), makeVideo("v2")];

  mocks.videoFindMany
    .mockResolvedValueOnce(featured) // featured hero
    .mockResolvedValueOnce(row) // new
    .mockResolvedValueOnce(row) // popular
    .mockResolvedValueOnce(row) // rated
    .mockResolvedValueOnce(row) // free
    .mockResolvedValueOnce(row); // trending pool
  mocks.videoGroupBy.mockResolvedValueOnce([
    { category: null, _count: { _all: 4 } },
    { category: "music", _count: { _all: 5 } },
    { category: "tech", _count: { _all: 6 } },
  ]);
  mocks.videoCount.mockResolvedValueOnce(24);
  mocks.userFindMany.mockResolvedValueOnce([
    { id: "c1", displayName: "Active", avatarUrl: null, isVerified: true, _count: { videos: 3 } },
    { id: "c2", displayName: "Empty", avatarUrl: null, isVerified: false, _count: { videos: 0 } },
  ]);
  // One creator with a published video; the strip below drops the second one.
  mocks.userCount.mockResolvedValueOnce(1);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/home-feed", () => {
  it("returns the cached payload without touching the database", async () => {
    const cached = { featured: { id: "cached" }, rows: {}, categories: {}, totalVideos: 1, creators: [] };
    mocks.cacheGet.mockResolvedValueOnce(cached);

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toEqual(cached);
    expect(mocks.videoFindMany).not.toHaveBeenCalled();
    expect(mocks.videoCount).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it("queries the DB on a cache miss and re-caches the result for 60s", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mocks.videoFindMany).toHaveBeenCalledTimes(6);
    expect(mocks.cacheSet).toHaveBeenCalledTimes(1);

    const [key, payload, ttl] = mocks.cacheSet.mock.calls[0];
    expect(key).toBe("home:feed:v1");
    expect(ttl).toBe(60);
    expect(payload.totalVideos).toBe(24);
    expect(payload.featured.id).toBe("v-featured");
    expect(Object.keys(payload.rows).sort()).toEqual([
      "free",
      "new",
      "popular",
      "rated",
      "trending",
    ]);
  });

  it("keeps '' category count as the TOTAL and drops 0-video creators", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();
    const payload = body.data;

    // null-category group (4) must not overwrite the total (24)
    expect(payload.categories[""]).toBe(24);
    expect(payload.categories.music).toBe(5);
    expect(payload.categories.tech).toBe(6);

    expect(payload.creators.map((c: any) => c.id)).toEqual(["c1"]);
    expect(payload.creators[0].videoCount).toBe(3);
  });

  // The hero prints this number, so it has to be the count of creators somebody
  // can actually go and watch — not the number of accounts with the CREATOR role.
  it("reports a real creator count, counted the same way as the strip", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.data.totalCreators).toBe(1);

    const where = mocks.userCount.mock.calls[0][0].where;
    expect(where).toMatchObject({ role: "CREATOR", isBanned: false });
    // "Has something published" is the same rule activeCreators applies, so the
    // hero number and the faces under it cannot disagree.
    expect(where.videos.some).toMatchObject({
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
    });
  });

  it("serializes createdAt to an ISO string on every video", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();

    for (const video of body.data.rows.new) {
      expect(typeof video.createdAt).toBe("string");
      expect(Number.isFinite(Date.parse(video.createdAt))).toBe(true);
    }
    expect(typeof body.data.featured.createdAt).toBe("string");
  });

  // `price` has to be destructured out of the row so the teaser resolver can see
  // it. Forgetting to put it back strips the price from every card in the feed —
  // no badge, and the UI can no longer tell a free scene from a paid one. That
  // regression shipped once; this is the guard.
  it("keeps price on every video, including the featured hero", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.data.featured.price).toBe(1000);
    for (const row of Object.values(body.data.rows) as any[][]) {
      for (const video of row) {
        expect(typeof video.price, `${video.id} price`).toBe("number");
      }
    }
  });

  // Source-transport fields are internal: publishing them lets a visitor request
  // the media directly and bypass every entitlement check we do.
  it("does not publish internal media transport fields", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    primeDb();

    const res = await GET({} as any);
    const body = await res.json();

    const forbidden = ["previewUrl", "bunnyVideoId", "teaserClipUrl", "teaserBunnyVideoId"];
    for (const video of body.data.rows.new) {
      for (const key of forbidden) {
        expect(video, `${video.id} leaked ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("withholds the teaser for a paid scene that has no trailer", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    const paidNoTrailer = [
      makeVideo("paid", { price: 5000, previewUrl: "https://scene.test/main.m3u8" }),
    ];
    mocks.videoFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(paidNoTrailer)
      .mockResolvedValueOnce(paidNoTrailer)
      .mockResolvedValueOnce(paidNoTrailer)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(paidNoTrailer);
    mocks.videoGroupBy.mockResolvedValueOnce([]);
    mocks.videoCount.mockResolvedValueOnce(1);
    mocks.userFindMany.mockResolvedValueOnce([]);

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.data.rows.new[0].teaserUrl).toBeNull();
  });

  it("serves the trailer clip — never the scene — when one exists", async () => {
    mocks.cacheGet.mockResolvedValueOnce(null);
    const withTrailer = [
      makeVideo("paid", {
        price: 5000,
        previewUrl: "https://scene.test/main.m3u8",
        teaserClipUrl: "https://trailer.test/short.m3u8",
      }),
    ];
    mocks.videoFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(withTrailer)
      .mockResolvedValueOnce(withTrailer)
      .mockResolvedValueOnce(withTrailer)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(withTrailer);
    mocks.videoGroupBy.mockResolvedValueOnce([]);
    mocks.videoCount.mockResolvedValueOnce(1);
    mocks.userFindMany.mockResolvedValueOnce([]);

    const res = await GET({} as any);
    const body = await res.json();

    expect(body.data.rows.new[0].teaserUrl).toBe("https://trailer.test/short.m3u8");
  });
});
