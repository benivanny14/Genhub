// =============================================================================
// GENHUB - Tests for /api/videos
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
//
// POST is covered too, for the slug: `Video.slug` is `@unique` and the slug is
// computed from the title, so a second video with the same title used to fail
// the insert outright — a generic 500 AFTER the file had been uploaded in full.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  userFindUnique: vi.fn(),
  count: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      create: mocks.create,
      count: mocks.count,
    },
    user: { findUnique: mocks.userFindUnique },
  },
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: (...args: unknown[]) => mocks.cacheGet(...args),
  cacheSet: (...args: unknown[]) => mocks.cacheSet(...args),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: async () => ({ userId: "creator-1", role: "CREATOR" }),
  };
});

import { GET, POST } from "./route";

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

// =============================================================================
// POST /api/videos — the slug
// =============================================================================

describe("POST /api/videos", () => {
  const body = {
    title: "Same title",
    price: 1000,
    teaserDuration: 15,
    bunnyVideoId: "abc-123",
    complianceAttested: true,
  };

  function postRequest(payload: Record<string, unknown> = body) {
    return new NextRequest("https://app.test/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** The `data` handed to prisma.video.create. */
  function createdData() {
    return (mocks.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
  }

  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({ kycStatus: "APPROVED", isBanned: false });
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "video-1",
      ...data,
    }));
  });

  it("gives a second video with the same title its own slug instead of failing", async () => {
    // The insert used to raise a unique-constraint error, which the route turned
    // into a generic 500 — so the creator's file was uploaded in full and no
    // video appeared, and their retry abandoned that upload in the library.
    mocks.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) =>
      where.slug === "same-title" ? { id: "already-there" } : null
    );

    const response = await POST(postRequest());

    expect(response.status).toBe(201);
    expect(createdData().slug).toBe("same-title-2");
  });

  it("keeps the plain slug when nothing holds it", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await POST(postRequest());

    expect(createdData().slug).toBe("same-title");
  });

  it("never writes an empty slug, whatever the title is", async () => {
    // A title of nothing but symbols slugs to "" — one empty slug is storable,
    // the second is the same collision again.
    mocks.findUnique.mockResolvedValue(null);

    await POST(postRequest({ ...body, title: "\u{1F336}\u{1F336}" }));

    expect(createdData().slug).toBe("video");
  });
});
