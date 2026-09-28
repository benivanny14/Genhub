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
    // Bunny's list, verbatim: 0 Queued · 1 Processing · 2 Encoding ·
    // 3 Finished · 4 Resolution finished · 5 Failed.
    //
    // 3 is the one that publishes, and it is asserted with a LOW progress on
    // purpose: reading 3 as "Transcoding" and waiting for status 4 (or 100%) is
    // what left finished videos spinning on the dashboard forever.
    expect(describeEncoding(0, 0).state).toBe("pending"); // queued at upload
    expect(describeEncoding(1, 0).state).toBe("processing"); // preview/format
    expect(describeEncoding(2, 0).state).toBe("processing"); // encoding
    expect(describeEncoding(3, 40).state).toBe("ready"); // finished
    expect(describeEncoding(4, 40).state).toBe("ready"); // one resolution done
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

  it("gives every known code Bunny's own name for it", () => {
    for (const [code, label] of Object.entries({
      0: "Queued",
      1: "Processing",
      2: "Encoding",
      3: "Finished",
      4: "Resolution finished",
      5: "Failed",
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
        // The stranded-upload rule below is about age, so every case starts from
        // a slot that was reserved a moment ago unless it says otherwise.
        createdAt: new Date(),
        encodingStatus: 0,
        encodeProgress: 0,
        encodingError: null,
        encodingCheckedAt: null,
        encodingNotifiedAt: null,
        // What each case writes is asserted below, so every case starts with the
        // host having said nothing.
        bunnyStorageBytes: null,
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
    // 8 minutes (480s) — the creator-guidelines floor. A shorter scene is held
    // back by the rule below, so the "happy path" fixture must clear it.
    //
    // `length` is what Bunny really sends: SECONDS. This fixture used to say
    // 480_000, which only worked because the reader divided by 1000 — so the
    // test agreed with the bug and would not have noticed the fix.
    bunnyState.details = { status: 4, encodeProgress: 100, length: 480 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.published).toBe(true);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
    expect(video.duration).toBe(480);

    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("success");
    expect(notifications[0].message).toContain("Encoding probe");
  });

  it("publishes a finished video even when Bunny reports it below 100%", async () => {
    // Status 3 (Finished) means the video is fully available. It used to be read
    // as "Transcoding" and held back until status 4 or 100%, so a finished scene
    // sat on the creator's dashboard spinning and never went live — which is
    // exactly what a creator reports as "it says transcoding and never uploads".
    bunnyState.details = { status: 3, encodeProgress: 62, length: 480 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.snapshot.state).toBe("ready");
    expect(result?.published).toBe(true);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
  });

  it("holds back a ready video shorter than the 8-minute guidelines floor", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 90 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.published).toBe(false);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
    expect(video.duration).toBe(90);

    // The creator is told why — a silent unpublished video is indistinguishable
    // from a bug from their side of the screen.
    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("error");
    expect(notifications[0].title).toMatch(/too short/i);
  });

  it("reads Bunny's `length` as seconds, so the 8-minute floor actually fires", async () => {
    // The live library's own answer for a 5-second upload: `length: 5`. Read as
    // milliseconds that rounded to 0, and 0 failed the `> 0` guard below — so
    // the shortest possible file sailed past a published "8 minutes minimum"
    // rule and landed on a paid feed, with `duration` left NULL as well.
    bunnyState.details = { status: 4, encodeProgress: 100, length: 5 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.published).toBe(false);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.duration).toBe(5);
    expect(video.isPublished).toBe(false);

    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/too short/i);
  });

  it("takes down a video that was already live when the length was learned", async () => {
    // Posts are published the moment they are uploaded, so a too-short scene is
    // public for the minutes Bunny needs to report its length. Without this the
    // "8 minutes minimum" rule would stop existing: the upload would be live and
    // playable, and the guideline would be a sentence on a form.
    await prisma.video.update({ where: { id: videoId }, data: { isPublished: true } });
    bunnyState.details = { status: 4, encodeProgress: 100, length: 120 };

    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);

    // And the creator is told what happened to the post, not that it "stays"
    // unpublished — it was up.
    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("error");
    expect(notifications[0].title).toMatch(/too short/i);
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

  // ---------------------------------------------------------------------------
  // What the host says it holds
  //
  // Stored so the creator's dashboard can show the host's own byte count beside
  // the progress bar. It is the number that makes a transfer which stopped
  // arriving visible, because the browser's percentage counts bytes handed to
  // the socket and Bunny's does not — see lib/host-bytes.ts.
  // ---------------------------------------------------------------------------

  it("records the byte count the host reports holding", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 480, storageSize: 437_736_786 };

    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.bunnyStorageBytes).toBe(437_736_786);
  });

  it("keeps the last count when a poll does not carry a size", async () => {
    // Bunny answering without `storageSize` says nothing about how much it
    // holds. Writing a 0 over a real number would put "Host holds 0 B" beside a
    // healthy video, which is the one reading this column must never fake.
    bunnyState.details = { status: 2, encodeProgress: 40, storageSize: 512_000 };
    await refreshVideoEncoding(videoId);

    bunnyState.details = { status: 3, encodeProgress: 70 };
    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.bunnyStorageBytes).toBe(512_000);
  });

  it("clamps a footprint too large for the column instead of losing the row's update", async () => {
    // storageSize counts every rendition, so a large source can pass the 32-bit
    // ceiling. An overflow would throw and take the rest of the update (status,
    // progress, checkedAt) with it.
    bunnyState.details = { status: 2, encodeProgress: 55, storageSize: 3_000_000_000 };

    await refreshVideoEncoding(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.bunnyStorageBytes).toBe(2_147_483_647);
    expect(video.encodeProgress).toBe(55);
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
      // Status 2 is Bunny's "Encoding" — the label the viewer's page shows.
      label: "Encoding",
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

  // ---------------------------------------------------------------------------
  // An upload that never arrived
  //
  // The row says "Queued", Bunny says status 0, and neither will ever change:
  // the slot was reserved and no byte was ever stored. Left alone it reads as a
  // video that is about to start, for as long as the account exists.
  // ---------------------------------------------------------------------------

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

  it("calls off an upload that never delivered a byte", async () => {
    bunnyState.details = { status: 0, encodeProgress: 0, storageSize: 0 };
    await prisma.video.update({
      where: { id: videoId },
      data: { createdAt: hoursAgo(7) },
    });

    const result = await refreshVideoEncoding(videoId);

    expect(result?.snapshot.state).toBe("failed");
    expect(result?.snapshot.error).toMatch(/never reached the video host/i);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
    // Error, not Bunny's 0: the dashboard reads this column for the badge, and
    // "Queued" is the answer that hides a dead upload.
    expect(video.encodingStatus).toBe(5);
    expect(video.encodingError).toMatch(/upload this video again/i);

    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("error");
  });

  it("leaves a fresh upload alone while it is still transferring", async () => {
    // The same empty slot, minutes old: this is what an upload in progress looks
    // like from Bunny's side, and calling it failed would tell a creator to
    // re-upload a file that is halfway there.
    bunnyState.details = { status: 0, encodeProgress: 0, storageSize: 0 };

    const result = await refreshVideoEncoding(videoId);

    expect(result?.snapshot.state).toBe("pending");
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.encodingStatus).toBe(0);
    // Recorded as 0, not left NULL: the dashboard says "Host holds 0 B" for it,
    // which is the truth about a transfer that has not delivered anything yet.
    expect(video.bunnyStorageBytes).toBe(0);
    expect(video.encodingError).toBeNull();
    expect(await prisma.notification.count({ where: { userId: creatorId } })).toBe(0);
  });

  it("does not call off an upload when Bunny did not report a size", async () => {
    // Absent is not zero: a response without storageSize says nothing about how
    // many bytes are held, and guessing would fail a good upload.
    bunnyState.details = { status: 1, encodeProgress: 0 };
    await prisma.video.update({
      where: { id: videoId },
      data: { createdAt: hoursAgo(7) },
    });

    const result = await refreshVideoEncoding(videoId);

    // 1 is Bunny's "Processing", so this is a video in flight, not a queue
    // entry — either way it is not a failed upload, which is what matters here.
    expect(result?.snapshot.state).toBe("processing");
  });
});
