// =============================================================================
// GENHUB - The creator's own video list
//
// GET /api/creator/videos is what the dashboard renders, and the byte counts it
// carries are the difference between "still transferring" and "the transfer
// stopped": the host's own number, and the size the creator's browser sent.
// Three things have to survive this boundary, and each has its own way of going
// wrong silently:
//
//   1. A count of 0 must arrive as 0, not as null. Bunny reports 0 for a video
//      whose transfer never completed, and that is the signal the line exists
//      for — collapsing it to "unknown" hides exactly the case it is meant to
//      show.
//   2. An unanswered host must arrive as null, not as 0. Rendering "Host holds
//      0 B" for a video Bunny has said nothing about accuses a healthy upload.
//   3. The raw columns stay internal, like every other encoding field: the
//      dashboard needs the numbers, not the schema.
//
// Runs against the real database (the rails in src/tests/setup-env.ts decide
// when), and only ever touches the rows it creates.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";

// The route asks for a CREATOR session; a request scope does not exist here, so
// the signed-in user is fixed and the rows below belong to them.
const ctx = vi.hoisted(() => ({ creatorId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: async () => ({ userId: ctx.creatorId, role: "CREATOR" as const }),
  };
});

// `bunnyState` here is only used indirectly (the page fetches with refresh=0).
// Mocked anyway so this suite can never reach the live Bunny API, whatever the
// local .env.local holds.
vi.mock("@/lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bunny")>();
  return { ...actual, isBunnyConfigured: () => false };
});

import prisma from "@/lib/db";
import { GET as creatorVideosGet } from "@/app/api/creator/videos/route";

const describeDB = process.env.DATABASE_URL ? describe : describe.skip;
const stamp = Date.now();

describeDB("GET /api/creator/videos — the host's byte count", () => {
  const creatorId = `host-bytes-creator-${stamp}`;
  const withCounts = `host-bytes-full-${stamp}`;
  const withNothing = `host-bytes-empty-${stamp}`;

  beforeAll(async () => {
    ctx.creatorId = creatorId;
    await prisma.user.create({
      data: {
        id: creatorId,
        email: `${creatorId}@host-bytes.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Host Bytes Creator",
        role: "CREATOR",
      },
    });
    await prisma.video.createMany({
      data: [
        {
          id: withCounts,
          creatorId,
          title: "Counted upload",
          bunnyVideoId: `host-bytes-full-${stamp}`,
          price: 1000,
          encodingStatus: 2,
          encodeProgress: 40,
          bunnyStorageBytes: 437_736_786,
          uploadSizeBytes: 851_443_712,
        },
        {
          id: withNothing,
          creatorId,
          title: "Not reported yet",
          bunnyVideoId: `host-bytes-empty-${stamp}`,
          price: 1000,
          encodingStatus: 0,
          encodeProgress: 0,
          // Both left NULL: the host has not answered for this one.
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.video.deleteMany({ where: { creatorId } });
    await prisma.user.deleteMany({ where: { id: creatorId } });
    await prisma.$disconnect();
  });

  it("carries the host's number and the creator's file size to the dashboard", async () => {
    // refresh=0: the first render reads stored state and never waits on Bunny.
    const response = await creatorVideosGet(
      new NextRequest("http://localhost/api/creator/videos?refresh=0")
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    const counted = body.data.videos.find((v: { id: string }) => v.id === withCounts);
    expect(counted.storedBytes).toBe(437_736_786);
    expect(counted.sourceBytes).toBe(851_443_712);
  });

  it("keeps an unanswered host distinguishable from an empty one", async () => {
    const response = await creatorVideosGet(
      new NextRequest("http://localhost/api/creator/videos?refresh=0")
    );
    const body = await response.json();
    const unreported = body.data.videos.find((v: { id: string }) => v.id === withNothing);

    // NULL, not 0. This is what stops the dashboard claiming the host holds
    // nothing when it has simply not reported yet.
    expect(unreported.storedBytes).toBeNull();
    expect(unreported.sourceBytes).toBeNull();
  });

  it("keeps an empty host visible as a real zero", async () => {
    // The stalled-transfer case, written the way Bunny reports it.
    await prisma.video.update({
      where: { id: withNothing },
      data: { bunnyStorageBytes: 0, uploadSizeBytes: 851_443_712 },
    });

    const response = await creatorVideosGet(
      new NextRequest("http://localhost/api/creator/videos?refresh=0")
    );
    const body = await response.json();
    const stalled = body.data.videos.find((v: { id: string }) => v.id === withNothing);

    expect(stalled.storedBytes).toBe(0);
    expect(stalled.sourceBytes).toBe(851_443_712);
  });

  it("does not leak the raw columns it reads them from", async () => {
    const response = await creatorVideosGet(
      new NextRequest("http://localhost/api/creator/videos?refresh=0")
    );
    const raw = JSON.stringify(await response.json());

    for (const column of ["bunnyStorageBytes", "uploadSizeBytes", "bunnyVideoId"]) {
      expect(raw, `${column} must not reach the client`).not.toContain(column);
    }
  });
});
