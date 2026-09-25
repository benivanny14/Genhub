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
  videoUpdate: vi.fn(),
  accessFindUnique: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  currentUser: vi.fn(),
  claimOnce: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: { findFirst: mocks.videoFindFirst, update: mocks.videoUpdate },
    videoAccess: { findUnique: mocks.accessFindUnique, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => mocks.currentUser() };
});

vi.mock("@/lib/redis", () => ({
  claimOnce: (...args: unknown[]) => mocks.claimOnce(...args),
  cacheDel: vi.fn(),
}));

import { GET } from "./route";

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
