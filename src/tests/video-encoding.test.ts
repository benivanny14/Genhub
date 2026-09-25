// =============================================================================
// GENHUB - Video encoding lifecycle
//
// Two things are easy to get wrong here and expensive to get wrong in
// production:
//
//   1. Treating "upload finished" as "video is live". Bunny transcodes after the
//      upload, so this puts a player with no manifest in front of paying viewers.
//   2. Notifying on every poll instead of once, which turns one finished video
//      into a stream of identical notifications.
//
// The mapping is tested exhaustively because a single wrong constant would hold
// every future upload back forever, and the lifecycle is tested against the real
// database so the "exactly once" promise is actually verified rather than assumed.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Controllable stand-in for Bunny so the lifecycle can be driven through every
// state without waiting minutes for a real transcode.
const bunnyState = vi.hoisted(() => ({
  configured: true,
  details: null as Record<string, unknown> | null,
  unreachable: false,
}));

vi.mock("@/lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => bunnyState.configured,
    getBunnyVideoDetails: async () => {
      if (bunnyState.unreachable) throw new Error("bunny unreachable");
      return bunnyState.details;
    },
  };
});

// The public detail route reads the session; these tests are about what an
// anonymous visitor can see, and a request scope is not available in vitest.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => null };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { isBunnyVideoId } from "@/lib/bunny";
import { GET as videoDetailGet } from "@/app/api/videos/[id]/route";
import {
  describeEncoding,
  refreshVideoEncoding,
} from "@/lib/services/video-encoding.service";

// -----------------------------------------------------------------------------
// 1. Bunny's numbers -> a state the product can act on
// -----------------------------------------------------------------------------

describe("describeEncoding", () => {
  it("treats an untracked row as untracked, never as ready", () => {
    // Side-loaded and demo rows have no Bunny id to poll. Calling them ready
    // would hand the encoding lifecycle control over content it cannot see.
    for (const status of [null, undefined]) {
      const snapshot = describeEncoding(status, 0);
      expect(snapshot.state).toBe("untracked");
      expect(snapshot.status).toBeNull();
    }
  });

  it("maps every Bunny code in the observed range", () => {
    expect(describeEncoding(0, 0).state).toBe("pending"); // queued at upload
    expect(describeEncoding(1, 0).state).toBe("pending"); // uploaded, not started
    expect(describeEncoding(2, 0).state).toBe("processing");
    expect(describeEncoding(3, 40).state).toBe("processing");
    expect(describeEncoding(4, 100).state).toBe("ready");
    expect(describeEncoding(5, 0).state).toBe("failed");
  });

  it("treats 100% progress as ready even if the status code disagrees", () => {
    // Bunny reports progress and status separately. Checking both means a
    // shifted code cannot strand every upload at "processing" forever.
    expect(describeEncoding(2, 100).state).toBe("ready");
    expect(describeEncoding(3, 100).state).toBe("ready");
  });

  it("keeps failures louder than progress", () => {
    // A file that failed at 30% must not be published as if it were fine.
    const failed = describeEncoding(5, 30);
    expect(failed.state).toBe("failed");
    expect(failed.progress).toBe(30);
  });

  it("clamps nonsense progress instead of rendering a broken bar", () => {
    expect(describeEncoding(2, -10).progress).toBe(0);
    expect(describeEncoding(2, 500).progress).toBe(100);
    expect(describeEncoding(2, NaN).progress).toBe(0);
  });

  it("gives every known code a readable label", () => {
    for (const [code, label] of Object.entries({
      0: "Queued",
      1: "Uploaded",
      2: "Processing",
      3: "Transcoding",
      4: "Finished",
      5: "Error",
    })) {
      expect(describeEncoding(Number(code), 0).label).toBe(label);
    }
  });
});

// -----------------------------------------------------------------------------
// 2. Which ids are worth polling at all
// -----------------------------------------------------------------------------

describe("isBunnyVideoId", () => {
  it("accepts real Bunny GUIDs", () => {
    expect(isBunnyVideoId("3d2229c4-7187-4e8c-bee2-d2e8ddca6d9a")).toBe(true);
    expect(isBunnyVideoId("3D2229C4-7187-4E8C-BEE2-D2E8DDCA6D9A")).toBe(true);
  });

  it("rejects the synthetic ids demo and side-loaded rows carry", () => {
    // bunnyVideoId is non-nullable, so these exist and must never be polled.
    expect(isBunnyVideoId("demo-video-1")).toBe(false);
    expect(isBunnyVideoId("")).toBe(false);
    expect(isBunnyVideoId(null)).toBe(false);
    expect(isBunnyVideoId(undefined)).toBe(false);
    expect(isBunnyVideoId("3d2229c4-7187-4e8c-bee2")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 3. The promise itself: publish when ready, tell the creator once
// -----------------------------------------------------------------------------

const describeDB = process.env.DATABASE_URL ? describe : describe.skip;
const stamp = Date.now();

describeDB("refreshVideoEncoding (real database)", () => {
  const creatorId = `enc-creator-${stamp}`;
  const videoId = `enc-video-${stamp}`;
  const bunnyVideoId = "3d2229c4-7187-4e8c-bee2-d2e8ddca6d9a";

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: creatorId,
        email: `${creatorId}@enc.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Encoding Creator",
        role: "CREATOR",
      },
    });
    await prisma.video.create({
      data: {
        id: videoId,
        creatorId,
        title: "Encoding probe",
        bunnyVideoId,
        price: 1000,
        // Exactly how a fresh Bunny upload is created.
        isPublished: false,
        encodingStatus: 0,
      },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: creatorId } });
    await prisma.video.deleteMany({ where: { id: videoId } });
    await prisma.user.deleteMany({ where: { id: creatorId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    bunnyState.configured = true;
    bunnyState.unreachable = false;
    bunnyState.details = null;
    await prisma.video.update({
      where: { id: videoId },
      data: {
        isPublished: false,
        encodingStatus: 0,
        encodeProgress: 0,
        encodingError: null,
        encodingCheckedAt: null,
        encodingNotifiedAt: null,
      },
    });
    await prisma.notification.deleteMany({ where: { userId: creatorId } });
  });

  it("keeps a still-processing video out of the public feed", async () => {
    bunnyState.details = { status: 2, encodeProgress: 37 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.snapshot.state).toBe("processing");
    expect(result?.published).toBe(false);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
    expect(video.encodeProgress).toBe(37);
    expect(video.encodingCheckedAt).not.toBeNull();
    // Nothing to tell the creator yet — and nothing sent.
    expect(await prisma.notification.count({ where: { userId: creatorId } })).toBe(0);
  });

  it("publishes and notifies the moment Bunny reports finished", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 12_000 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.published).toBe(true);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
    expect(video.duration).toBe(12);

    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("success");
    expect(notifications[0].message).toContain("Encoding probe");
  });

  it("notifies exactly once, no matter how often it polls", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100 };

    await refreshVideoEncoding(videoId);
    await refreshVideoEncoding(videoId);
    await refreshVideoEncoding(videoId);

    expect(await prisma.notification.count({ where: { userId: creatorId } })).toBe(1);
  });

  it("never un-publishes a video the creator already took down", async () => {
    // The poller may only ever flip false -> true. Otherwise a creator who
    // unpublishes a scene would see it come back on the next cron tick.
    await prisma.video.update({ where: { id: videoId }, data: { isPublished: true } });
    bunnyState.details = { status: 4, encodeProgress: 100 };

    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
  });

  it("reports a failure once, with Bunny's own reason", async () => {
    bunnyState.details = {
      status: 5,
      encodeProgress: 12,
      transcodingMessages: [{ message: "Unsupported video codec" }],
    };

    await refreshVideoEncoding(videoId);
    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodingError).toBe("Unsupported video codec");
    expect(video.isPublished).toBe(false);

    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("error");
    expect(notifications[0].message).toContain("Unsupported video codec");
  });

  it("leaves state untouched when Bunny cannot be reached", async () => {
    bunnyState.details = { status: 2, encodeProgress: 50 };
    await refreshVideoEncoding(videoId);

    bunnyState.unreachable = true;
    expect(await refreshVideoEncoding(videoId)).toBeNull();

    // Still exactly what the last successful poll recorded.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodeProgress).toBe(50);
    expect(video.isPublished).toBe(false);
  });

  it("publishes the encoding state without leaking the raw columns", async () => {
    // The detail route uses `include:`, so every column on Video is in scope and
    // any column added later leaks by default. These five arrived with the
    // encoding lifecycle, so this test is the guard that they stayed internal.
    bunnyState.details = { status: 2, encodeProgress: 42 };
    await refreshVideoEncoding(videoId);

    // Live, because the route refuses an unpublished video to anyone but its
    // creator or an admin, and this call is a signed-out visitor. What is under
    // test is which COLUMNS reach the client, so the video has to be reachable
    // at all — otherwise every assertion below reads a 404.
    await prisma.video.update({ where: { id: videoId }, data: { isPublished: true } });

    const response = await videoDetailGet(
      new NextRequest(`http://localhost/api/videos/${videoId}`),
      { params: Promise.resolve({ id: videoId }) } as never
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.data.encoding).toMatchObject({
      state: "processing",
      progress: 42,
      label: "Processing",
    });

    const raw = JSON.stringify(body);
    for (const column of [
      "encodingStatus",
      "encodeProgress",
      "encodingError",
      "encodingCheckedAt",
      "encodingNotifiedAt",
    ]) {
      expect(raw, `${column} must not reach the client`).not.toContain(column);
    }
    // The other fields the route deliberately strips, for the same reason.
    expect(raw).not.toContain("bunnyVideoId");
    expect(raw).not.toContain("previewUrl");
  });

  it("ignores rows Bunny does not transcode", async () => {
    bunnyState.configured = true;
    await prisma.video.update({ where: { id: videoId }, data: { encodingStatus: null } });
    bunnyState.details = { status: 4, encodeProgress: 100 };

    // Null encoding status = side-loaded content: the lifecycle must not touch it.
    expect(await refreshVideoEncoding(videoId)).toBeNull();
  });
});
