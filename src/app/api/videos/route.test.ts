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
  cacheDel: vi.fn(),
  /**
   * What the host answers when the finalizer asks it to confirm an asset.
   *
   * `bunnyFails` models Bunny being unreachable or refusing; `bunnyGuid` models
   * the provider returning a DIFFERENT video than the id the browser sent, which
   * is the case a client-supplied id makes possible and the one that must never
   * reach a database write.
   */
  bunnyFails: false,
  bunnyGuid: null as string | null,
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      create: mocks.create,
      count: mocks.count,
      // The scheduled-publish sweep runs at the top of the feed read.
      updateMany: async () => ({ count: 0 }),
    },
    user: { findUnique: mocks.userFindUnique },
  },
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: (...args: unknown[]) => mocks.cacheGet(...args),
  cacheSet: (...args: unknown[]) => mocks.cacheSet(...args),
  cacheDel: (...args: unknown[]) => mocks.cacheDel(...args),
  checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0, degraded: false }),
}));

// The upload path only marks a video as needing transcoding when Bunny is
// configured AND the id looks like Bunny's. Both are mocked here so the
// instant-publication case below runs the real branch instead of the
// side-loaded one, without an environment that has a Stream library.
vi.mock("@/lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => true,
    isBunnyVideoId: (id: string) => !!id,
    getBunnyVideoDetails: async (id: string) => {
      if (mocks.bunnyFails) throw new Error("bunny is unreachable");
      return { guid: mocks.bunnyGuid ?? id };
    },
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: async () => ({ userId: "creator-1", role: "CREATOR" }),
  };
});

vi.mock("@/lib/video-upload-session", () => ({
  verifyVideoUploadSession: async (token: string) =>
    token
      ? {
          sessionToken: token,
          userId: "creator-1",
          videoId: "abc-123",
          uploadUrl: "https://video.bunnycdn.com/tusupload/test",
          headers: {},
          totalBytes: 100,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }
      : null,
  confirmVideoUpload: async () => ({ ok: true, offset: 100 }),
}));

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

  it("answers a nonsense page number with the first page, not a 500", async () => {
    // `Math.max(1, parseInt("abc"))` is NaN, and Prisma refuses a NaN take/skip
    // — so a shared link with a mangled `?page=` was an error page.
    const response = await GET(request("?page=abc&limit=nonsense"));

    expect(response.status).toBe(200);
    expect(findManyArgs().take).toBe(20);
  });

  it("caps the page size and refuses a negative page", async () => {
    await GET(request("?page=-4&limit=5000"));

    const args = mocks.findMany.mock.calls[0][0] as { take: number; skip: number };
    expect(args.take).toBe(50);
    expect(args.skip).toBe(0);
  });

  it("keeps a post Bunny is still transcoding, and drops one it failed", async () => {
    // Instant publication: a PROCESSING post is live and must be in the grid —
    // that is the whole change. A FAILED one can never play, so it must not be.
    await GET(request(""));

    const filter = findManyArgs().where.OR as { encodingStatus?: unknown }[];
    // Written as an OR rather than `{ not: 5 }` on purpose: a `not` comparison
    // matches no NULL, and NULL is every side-loaded, demo and pre-lifecycle
    // row — the filter would have emptied the catalogue.
    expect(filter).toContainEqual({ encodingStatus: null });
    expect(filter).toContainEqual({ encodingStatus: { not: 5 } });
  });

  it("ANDs a search onto that filter instead of replacing it", async () => {
    // Search needs its own OR, and two ORs cannot share a key — the second one
    // would silently win and the feed filter above would stop applying.
    await GET(request("?q=ngoma"));

    const { where } = findManyArgs();
    expect(where.OR).toBeDefined();
    expect(where.AND).toBeDefined();
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
    uploadSessionToken: "session-token-" + "x".repeat(90),
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
    mocks.bunnyFails = false;
    mocks.bunnyGuid = null;
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

  it("publishes the post immediately, with the encode marked as running", async () => {
    // This is the Instagram behaviour: the post exists the second the bytes
    // land, and the badge says the video is still being prepared. Holding the
    // row back until Bunny finished is what made a creator's upload invisible
    // to everyone, themselves included, for the whole transcode.
    mocks.findUnique.mockResolvedValue(null);

    const response = await POST(postRequest());
    const data = await response.json();

    expect(createdData().isPublished).toBe(true);
    expect(createdData().encodingStatus).toBe(0);
    expect(data.data.status).toBe("PROCESSING");
    expect(response.status).toBe(201);
  });

  it("drops the cached feed so the new post is not invisible for a minute", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await POST(postRequest());

    expect(mocks.cacheDel).toHaveBeenCalledWith("videos:*");
  });
});

// =============================================================================
// POST /api/videos — finalizing a transfer that already happened
//
// The bytes go to Bunny before this request is ever made, so a lost response
// used to be unrecoverable in the worst possible way: the creator saw "Network
// error" after a 700 MB upload, and their options were to give up or to push the
// whole file again. Retrying the POST now returns the row that already exists,
// keyed on the Bunny id — and the id is verified against the host first, because
// a browser-supplied id must never be able to publish a row for an asset that is
// not its own.
// =============================================================================

describe("POST /api/videos — finalization is idempotent", () => {
  const body = {
    title: "Same title",
    price: 1000,
    teaserDuration: 15,
    bunnyVideoId: "abc-123",
    uploadSessionToken: "session-token-" + "x".repeat(90),
    complianceAttested: true,
  };

  function postRequest(payload: Record<string, unknown> = body) {
    return new NextRequest("https://app.test/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** An already-finalized row, as the idempotency lookup would find it. */
  const existingRow = {
    id: "video-1",
    creatorId: "creator-1",
    title: "Same title",
    slug: "same-title",
    bunnyVideoId: "abc-123",
    price: 1000,
    isPublished: true,
    encodingStatus: 0,
    encodeProgress: 0,
    createdAt: new Date(),
  };

  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({ kycStatus: "APPROVED", isBanned: false });
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "video-1",
      ...data,
    }));
    mocks.bunnyFails = false;
    mocks.bunnyGuid = null;
  });

  it("returns the existing post instead of writing a second row", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.bunnyVideoId ? existingRow : null
    );

    const response = await POST(postRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(data.data.id).toBe("video-1");
    // The row is still transcoding, and the replay says so rather than claiming
    // the video is ready — the creator is about to be told what to expect.
    expect(data.data.status).toBe("PROCESSING");
    expect(data.message).toMatch(/already finalized/i);
  });

  it("refuses a Bunny id that belongs to another creator", async () => {
    // The id is a client-supplied key into somebody else's upload. Replaying it
    // must not hand this creator a row pointing at an asset they do not own.
    mocks.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.bunnyVideoId ? { ...existingRow, creatorId: "someone-else" } : null
    );

    const response = await POST(postRequest());

    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses to write a row when the host will not confirm the asset", async () => {
    // Unreachable or refusing is the one answer that must not be treated as
    // success: a row written without it points at an asset nobody has checked.
    mocks.findUnique.mockResolvedValue(null);
    mocks.bunnyFails = true;

    const response = await POST(postRequest());
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.code).toBe("UPLOAD_VERIFY_FAILED");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an id the host says belongs to a different video", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findUnique.mockResolvedValue(null);
    mocks.bunnyGuid = "a-different-guid";

    const response = await POST(postRequest());
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.code).toBe("ASSET_MISMATCH");
    // The two ids involved are the diagnosis and stay in the log; the creator is
    // told the upload could not be confirmed, without the provider's name.
    expect(data.error).not.toMatch(/Bunny|bunny/i);
    expect(String(data.reference)).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(logged.mock.calls.flat().join(" ")).toContain("a-different-guid");
    expect(mocks.create).not.toHaveBeenCalled();

    logged.mockRestore();
  });
});
