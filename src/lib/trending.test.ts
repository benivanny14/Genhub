// =============================================================================
// GENHUB - Tests for shared trending / feed helpers
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  trendingScore,
  rankTrending,
  buildCategoryCounts,
  activeCreators,
} from "./trending";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

describe("trendingScore", () => {
  it("ranks a fresh engaged video above an older one with identical engagement", () => {
    const fresh = trendingScore(
      { createdAt: daysAgo(0), purchaseCount: 10, likesCount: 10, viewsCount: 1000 },
      NOW
    );
    const old = trendingScore(
      { createdAt: daysAgo(30), purchaseCount: 10, likesCount: 10, viewsCount: 1000 },
      NOW
    );
    expect(fresh).toBeGreaterThan(old);
  });

  it("weighs purchases (×5) above likes (×2) above views (×0.1)", () => {
    const buyers = trendingScore({ createdAt: daysAgo(1), purchaseCount: 10 }, NOW);
    const likers = trendingScore({ createdAt: daysAgo(1), likesCount: 10 }, NOW);
    const viewers = trendingScore({ createdAt: daysAgo(1), viewsCount: 10 }, NOW);
    expect(buyers).toBeGreaterThan(likers);
    expect(likers).toBeGreaterThan(viewers);
  });

  it("decays the same video's score as it ages", () => {
    const base = { purchaseCount: 5, likesCount: 5, viewsCount: 500 };
    const day0 = trendingScore({ ...base, createdAt: daysAgo(0) }, NOW);
    const day7 = trendingScore({ ...base, createdAt: daysAgo(7) }, NOW);
    const day30 = trendingScore({ ...base, createdAt: daysAgo(30) }, NOW);
    expect(day0).toBeGreaterThan(day7);
    expect(day7).toBeGreaterThan(day30);
    expect(day30).toBeGreaterThan(0); // decays, never disappears
  });

  it("scores zero-engagement videos at 0", () => {
    expect(trendingScore({ createdAt: daysAgo(0) }, NOW)).toBe(0);
    expect(
      trendingScore(
        { createdAt: daysAgo(0), purchaseCount: 0, likesCount: 0, viewsCount: 0 },
        NOW
      )
    ).toBe(0);
  });

  it("accepts Date and ISO-string createdAt interchangeably", () => {
    const item = { purchaseCount: 3, likesCount: 3, viewsCount: 300 };
    const fromDate = trendingScore({ ...item, createdAt: daysAgo(2) }, NOW);
    const fromString = trendingScore(
      { ...item, createdAt: daysAgo(2).toISOString() },
      NOW
    );
    const fromNumber = trendingScore({ ...item, createdAt: NOW - 2 * 86_400_000 }, NOW);
    expect(fromString).toBeCloseTo(fromDate, 5);
    expect(fromNumber).toBeCloseTo(fromDate, 5);
  });

  it("treats null counters as zero", () => {
    const withNulls = trendingScore(
      { createdAt: daysAgo(0), purchaseCount: null, likesCount: null, viewsCount: 100 },
      NOW
    );
    const withZeros = trendingScore({ createdAt: daysAgo(0), viewsCount: 100 }, NOW);
    expect(withNulls).toBe(withZeros);
  });
});

describe("rankTrending", () => {
  it("orders items from highest to lowest score", () => {
    const items = [
      { id: "stale-hit", createdAt: daysAgo(60), purchaseCount: 50, likesCount: 0, viewsCount: 0 },
      { id: "fresh-hit", createdAt: daysAgo(1), purchaseCount: 40, likesCount: 30, viewsCount: 500 },
      { id: "dead", createdAt: daysAgo(1), purchaseCount: 0, likesCount: 0, viewsCount: 0 },
    ];
    const ranked = rankTrending(items, NOW);
    expect(ranked.map((v) => v.id)).toEqual(["fresh-hit", "stale-hit", "dead"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { id: "b", createdAt: daysAgo(10), likesCount: 1, viewsCount: 0, purchaseCount: 0 },
      { id: "a", createdAt: daysAgo(0), likesCount: 5, viewsCount: 0, purchaseCount: 0 },
    ];
    const originalOrder = items.map((v) => v.id);
    const ranked = rankTrending(items, NOW);
    expect(ranked).not.toBe(items);
    expect(items.map((v) => v.id)).toEqual(originalOrder);
  });
});

describe("buildCategoryCounts", () => {
  it("keeps '' as TOTAL even when some rows have a null category", () => {
    const counts = buildCategoryCounts(
      [
        { category: null, count: 7 }, // uncategorised videos
        { category: "music", count: 5 },
        { category: "tech", count: 6 },
      ],
      24
    );
    expect(counts[""]).toBe(24); // must NOT be overwritten by the null-category row
    expect(counts.music).toBe(5);
    expect(counts.tech).toBe(6);
  });

  it("sums rows that share the same category", () => {
    const counts = buildCategoryCounts(
      [
        { category: "sports", count: 2 },
        { category: "sports", count: 1 },
      ],
      3
    );
    expect(counts.sports).toBe(3);
    expect(counts[""]).toBe(3);
  });

  it("does not invent categories for an empty group result", () => {
    expect(buildCategoryCounts([], 0)).toEqual({ "": 0 });
  });
});

describe("activeCreators", () => {
  it("drops creators with zero published videos", () => {
    const list = [
      { id: "a", videoCount: 5 },
      { id: "b", videoCount: 0 },
      { id: "c", videoCount: 2 },
      { id: "d", videoCount: 0 },
    ];
    expect(activeCreators(list).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("returns a new array (input untouched)", () => {
    const list = [{ id: "a", videoCount: 1 }];
    const result = activeCreators(list);
    expect(result).not.toBe(list);
    expect(list).toHaveLength(1);
  });
});
