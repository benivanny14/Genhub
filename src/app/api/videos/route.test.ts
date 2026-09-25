// =============================================================================
// GENHUB - Tests for GET /api/videos?creatorId=<id>
//
// A creator's public page asks for that creator's videos. The parameter was read
// into a variable and then never used: `creatorId` was missing from both the
// WHERE clause and the cache key, so /creator/<id> rendered the ENTIRE site feed
// under "Videos by <name>" — the visitor could not tell one creator's work from
// the whole catalogue, and the page's own heading lied about what it showed.
//
// Two things are pinned here, because fixing only the query would have left the
// bug alive through the cache:
//   1. the LIST is filtered by creatorId (and unfiltered without it), and
//   2. the CACHE KEY includes creatorId, so one creator's page can never be
//      served another creator's cached response.
//
// Prisma and redis are mocked — no database and no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { video: { findMany: mocks.findMany, count: mocks.count } },
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: (...args: unknown[]) => mocks.cacheGet(...args),
  cacheSet: (...args: unknown[]) => mocks.cacheSet(...args),
}));

import { GET } from "./route";

function request(query: string) {
  return new NextRequest(`https://app.test/api/videos${query}`);
}

/** The `where` (or `select`) handed to prisma on the findMany call. */
function findManyArgs() {
  return mocks.findMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
    take: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheGet.mockResolvedValue(null);
  mocks.count.mockResolvedValue(0);
  mocks.findMany.mockResolvedValue([]);
});

describe("GET /api/videos", () => {
  it("filters the list by creatorId instead of returning every video", async () => {
    await GET(request("?creatorId=creator-1"));

    expect(findManyArgs().where.creatorId).toBe("creator-1");
  });

  it("leaves the public feed unfiltered when no creator is asked for", async () => {
    await GET(request(""));

    expect(findManyArgs().where.creatorId).toBeUndefined();
  });

  it("keeps the public-feed guarantees when filtering by creator", async () => {
    await GET(request("?creatorId=creator-1"));

    const { where } = findManyArgs();
    expect(where.isPublished).toBe(true);
    expect(where.isDeleted).toBe(false);
    expect(where.isFlagged).toBe(false);
  });

  it("caches each creator's list under its own key", async () => {
    await GET(request("?creatorId=creator-1"));
    await GET(request("?creatorId=creator-2"));

    const firstKey = mocks.cacheSet.mock.calls[0][0] as string;
    const secondKey = mocks.cacheSet.mock.calls[1][0] as string;

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain("creator-1");
    expect(secondKey).toContain("creator-2");
  });

  it("does not serve a creator's list from the general feed's cache", async () => {
    // The general feed was cached under a key that did not name a creator, so a
    // creator page could be answered entirely from cache — the filter above
    // would never run.
    await GET(request(""));
    await GET(request("?creatorId=creator-1"));

    const generalKey = mocks.cacheSet.mock.calls[0][0] as string;
    const creatorKey = mocks.cacheSet.mock.calls[1][0] as string;

    expect(creatorKey).not.toBe(generalKey);
  });
});
