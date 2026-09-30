// =============================================================================
// GENHUB - Tests for POST /api/videos/status
//
// The endpoint every open page polls while something is processing. Three rules
// matter and all three have been a bug in some form already:
//
//   1. it is READ-ONLY — it must never touch Bunny, because a viewer's open tab
//      is not allowed to spend an API call at the host;
//   2. it is bounded — a caller must not be able to turn it into a table scan;
//   3. it reports the three publication states, and an untracked row (Bunny
//      never transcodes it) is READY, not a badge nothing would ever clear.
//
// Prisma is mocked — no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  bunnyDetails: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { video: { findMany: mocks.findMany } },
}));

// The shared rate limiter, stubbed so the suite never dials Redis, and the
// session, stubbed so the privacy branch is exercised without a cookie jar.
vi.mock("@/lib/redis", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: 0, degraded: false }),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => mocks.currentUser(),
}));

vi.mock("@/lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bunny")>();
  return { ...actual, getBunnyVideoDetails: mocks.bunnyDetails };
});

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://app.test/api/videos/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The `where` handed to prisma. */
function where() {
  return (mocks.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.currentUser.mockResolvedValue(null);
});

describe("POST /api/videos/status", () => {
  it("refuses a body with no ids instead of guessing", async () => {
    const response = await POST(request({ ids: "video-1" }));

    expect(response.status).toBe(422);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("deletes nothing: it only ever asks about rows that are not deleted", async () => {
    await POST(request({ ids: ["v1"] }));

    expect(where().isDeleted).toBe(false);
    expect(where().id).toEqual({ in: ["v1"] });
  });

  it("never calls the video host", async () => {
    // The whole point of a batched, read-only endpoint: a page full of
    // processing cards must not become API calls at Bunny.
    await POST(request({ ids: ["v1", "v2"] }));

    expect(mocks.bunnyDetails).not.toHaveBeenCalled();
  });

  it("reports the three states, and calls an untracked row READY", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "processing", encodingStatus: 1, encodeProgress: 30, isPublished: true, creatorId: "c1" },
      { id: "ready", encodingStatus: 4, encodeProgress: 100, isPublished: true, creatorId: "c1" },
      { id: "failed", encodingStatus: 5, encodeProgress: 0, isPublished: true, creatorId: "c1" },
      // Side-loaded/demo rows: Bunny never transcodes them, and a badge here
      // would be permanent.
      { id: "untracked", encodingStatus: null, encodeProgress: 0, isPublished: true, creatorId: "c1" },
    ]);

    const response = await POST(request({ ids: ["processing", "ready", "failed", "untracked"] }));
    const body = await response.json();

    expect(body.data.statuses).toEqual({
      processing: { status: "PROCESSING", progress: 30 },
      ready: { status: "READY", progress: 100 },
      failed: { status: "FAILED", progress: 0 },
      untracked: { status: "READY", progress: 0 },
    });
    // What a caller uses to stop polling: nothing left that can change.
    expect(body.data.processing).toBe(1);
  });

  it("deduplicates the ids and ignores anything that cannot name a row", async () => {
    await POST(request({ ids: ["v1", "v1", " ", "", 42, null, "x".repeat(200)] }));

    expect(where().id).toEqual({ in: ["v1"] });
  });

  it("caps how much one request can ask about", async () => {
    await POST(request({ ids: Array.from({ length: 500 }, (_, i) => `v${i}`) }));

    const asked = (where().id as { in: string[] }).in;
    expect(asked).toHaveLength(100);
  });

  it("answers an empty page without a query at all", async () => {
    const response = await POST(request({ ids: ["", 7] }));

    expect(response.status).toBe(200);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("never reveals an unpublished video's status to an anonymous caller", async () => {
    // The leak this closes: an unpublished row (pulled from the feed, or still
    // uploading) must not have its existence or its encode progress confirmed to
    // a stranger, or the endpoint becomes an oracle for hidden videos.
    mocks.findMany.mockResolvedValue([
      { id: "hidden", encodingStatus: 1, encodeProgress: 42, isPublished: false, creatorId: "c1" },
    ]);

    const response = await POST(request({ ids: ["hidden"] }));
    const body = await response.json();

    expect(body.data.statuses).toEqual({});
    expect(body.data.processing).toBe(0);
  });

  it("lets the owner see their own unpublished video's status", async () => {
    mocks.currentUser.mockResolvedValue({ userId: "c1", role: "CREATOR" });
    mocks.findMany.mockResolvedValue([
      { id: "draft", encodingStatus: 1, encodeProgress: 12, isPublished: false, creatorId: "c1" },
    ]);

    const response = await POST(request({ ids: ["draft"] }));
    const body = await response.json();

    expect(body.data.statuses.draft).toEqual({ status: "PROCESSING", progress: 12 });
  });

  it("drops ids that cannot name a row before they reach the query", async () => {
    await POST(request({ ids: ["ok-1", "bad id!", "../../etc", "x".repeat(200)] }));

    expect(where().id).toEqual({ in: ["ok-1"] });
  });
});
