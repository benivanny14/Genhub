// =============================================================================
// GENHUB - Tests for GET /api/videos/[id] — who may read an unpublished video
//
// A video starts unpublished: Bunny has to transcode it before it can play, and
// publishing early shows viewers a scene that fails. "Take out of the feed" also
// leaves a row unpublished on purpose. None of that was enforced on this route,
// so the row id (or slug) was enough to read a video nobody had published — with
// its title, description, price and the creator's name — and it was the same id
// the creator's own dashboard links to.
//
// The rule pinned here: unpublished is private, except to the creator who owns
// the row and to an admin. And a creator's own preview must not be counted as a
// view, because viewsCount ranks the feed.
//
// Prisma, auth and the redis helpers are mocked — no database and no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  videoFindFirst: vi.fn(),
  videoFindUnique: vi.fn(),
  videoUpdate: vi.fn(),
  accessFindUnique: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  currentUser: vi.fn(),
  requireAuth: vi.fn(),
  claimOnce: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: {
      findFirst: mocks.videoFindFirst,
      findUnique: mocks.videoFindUnique,
      update: mocks.videoUpdate,
    },
    videoAccess: { findUnique: mocks.accessFindUnique, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: () => mocks.currentUser(),
    requireAuth: () => mocks.requireAuth(),
  };
});

vi.mock("@/lib/redis", () => ({
  claimOnce: (...args: unknown[]) => mocks.claimOnce(...args),
  cacheDel: vi.fn(),
}));

import { GET, PATCH } from "./route";

const CREATOR = "creator-1";
const VIEWER = "viewer-9";

const params = { params: { id: "video-1" } };

function videoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "video-1",
    creatorId: CREATOR,
    title: "Still processing",
    description: null,
    slug: "still-processing",
    thumbnailUrl: null,
    previewUrl: null,
    bunnyVideoId: null,
    teaserBunnyVideoId: null,
    teaserClipUrl: null,
    price: 1000,
    teaserDuration: 15,
    duration: 120,
    viewsCount: 0,
    likesCount: 0,
    purchaseCount: 0,
    category: null,
    isPremium: false,
    isFeatured: false,
    tags: [],
    isPublished: false,
    isDeleted: false,
    isFlagged: false,
    complianceAttestedAt: null,
    encodingStatus: 2,
    encodeProgress: 50,
    encodingError: null,
    encodingCheckedAt: null,
    encodingNotifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    galleryImages: [],
    creator: { id: CREATOR, displayName: "Amani", avatarUrl: null },
    ...overrides,
  };
}

async function get() {
  const response = await GET(new NextRequest("https://app.test/api/videos/video-1"), params);
  const body = await response.json();
  return { status: response.status, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimOnce.mockResolvedValue(true);
  mocks.currentUser.mockResolvedValue(null);
  mocks.videoFindFirst.mockResolvedValue(videoRow());
  mocks.videoFindUnique.mockResolvedValue(videoRow());
  mocks.requireAuth.mockResolvedValue({ userId: CREATOR, role: "CREATOR" });
  mocks.accessFindUnique.mockResolvedValue(null);
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.subscriptionFindFirst.mockResolvedValue(null);
});

describe("GET /api/videos/[id] — unpublished videos", () => {
  it("hides an unpublished video from a signed-out visitor", async () => {
    const { status, body } = await get();

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  it("hides an unpublished video from a viewer who does not own it", async () => {
    mocks.currentUser.mockResolvedValue({ userId: VIEWER, role: "VIEWER" });

    expect((await get()).status).toBe(404);
  });

  it("lets the creator preview their own unpublished video", async () => {
    mocks.currentUser.mockResolvedValue({ userId: CREATOR, role: "CREATOR" });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.data.id).toBe("video-1");
  });

  it("lets an admin see an unpublished video", async () => {
    mocks.currentUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });

    expect((await get()).status).toBe(200);
  });

  it("does not count the creator's own preview as a view", async () => {
    mocks.currentUser.mockResolvedValue({ userId: CREATOR, role: "CREATOR" });

    await get();

    expect(mocks.videoUpdate).not.toHaveBeenCalled();
  });

  it("still counts a viewer's view of a published video", async () => {
    mocks.videoFindFirst.mockResolvedValue(videoRow({ isPublished: true }));

    const { status } = await get();

    expect(status).toBe(200);
    expect(mocks.videoUpdate).toHaveBeenCalledWith({
      where: { id: "video-1" },
      data: { viewsCount: { increment: 1 } },
    });
  });
});

// =============================================================================
// PATCH — the teaser column may never hold the video itself
//
// The upload schema has refused this all along, and this route is the one that
// can do it to a video that is ALREADY live: point the teaser at the scene, and
// `?source=teaser` — which serves without an entitlement check, because a trailer
// is for people who have not paid — hands the whole video to anybody, signed in
// or not. The check is against the stored row, not against the request body, so
// it cannot be dodged by omitting the main id.
// =============================================================================

describe("PATCH /api/videos/[id] — a teaser may not be the scene", () => {
  const SCENE = "scene-guid-1111";

  async function patch(body: unknown) {
    const response = await PATCH(
      new NextRequest("https://app.test/api/videos/video-1", {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      params
    );
    return { status: response.status, body: await response.json() };
  }

  it("refuses to point the teaser at the video's own Bunny id", async () => {
    mocks.videoFindUnique.mockResolvedValue(videoRow({ bunnyVideoId: SCENE }));

    const { status, body } = await patch({ teaserBunnyVideoId: SCENE });

    expect(status).toBe(422);
    expect(body.error).toMatch(/different video from the main video/);
    expect(mocks.videoUpdate).not.toHaveBeenCalled();
  });

  it("accepts a genuinely separate trailer clip", async () => {
    mocks.videoFindUnique.mockResolvedValue(videoRow({ bunnyVideoId: SCENE }));
    mocks.videoUpdate.mockResolvedValue({ id: "video-1", title: "x" });

    const { status } = await patch({ teaserBunnyVideoId: "trailer-guid-2222" });

    expect(status).toBe(200);
  });

  it("still lets a creator edit their own video", async () => {
    mocks.videoUpdate.mockResolvedValue({ id: "video-1", title: "x" });

    const { status } = await patch({ price: 1500 });

    expect(status).toBe(200);
    expect(mocks.videoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ price: 1500 }) })
    );
  });

  it("refuses a creator editing somebody else's video", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: VIEWER, role: "VIEWER" });

    const { status } = await patch({ price: 0 });

    expect(status).toBe(403);
    expect(mocks.videoUpdate).not.toHaveBeenCalled();
  });
});
