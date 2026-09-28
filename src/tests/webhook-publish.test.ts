// =============================================================================
// GENHUB - The publish path, driven end to end by a signed callback
//
// Every part of this path had a test; the path did not. bunny-webhook.test.ts
// checks the signature rule in isolation, video-encoding.test.ts checks the
// lifecycle against a database, and the route that joins them was covered by
// nothing — so a change in the wire format, the parsing, the intent mapping or
// the route's own wiring could break instant publishing with every existing test
// still green.
//
// What this suite does instead is the whole journey: sign a body exactly as
// Bunny does, POST it to the real route handler, and then read the database.
// The four layers under test are, in order:
//
//   HMAC over the raw bytes  ->  the route  ->  intent  ->  the lifecycle
//
// A transcribed assertion is not enough on its own, so the negative cases are
// here too: an unsigned callback, a forged signature (the body no longer matches
// the digest), a body from another Stream library, and a guid with no row. Each
// must leave the database exactly as it found it. A publish path that only
// proves it can publish is half a test.
//
// Database-backed, like the lifecycle suite next door: it gates on
// DATABASE_URL and skips itself when the harness has deliberately cleared it
// (see tests/setup-env.ts — a plain `npm test` must never rewrite real data).
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// -----------------------------------------------------------------------------
// Environment and collaborators, before anything imports config or the route
// -----------------------------------------------------------------------------

/**
 * `vi.hoisted` runs before the imports below, which is the only way to give
 * config a signing secret: it reads process.env once, at module load.
 *
 * The fallbacks keep the suite honest on a machine with no .env.local (CI): a
 * secret has to exist for the route to enforce a signature at all, and the
 * library id has to exist for a callback from a different library to be
 * distinguishable from one of ours.
 */
const env = vi.hoisted(() => {
  process.env.BUNNY_STREAM_WEBHOOK_SECRET ||= "test-readonly-key-not-a-real-secret";
  process.env.BUNNY_STREAM_LIBRARY_ID ||= "760553";
  return {
    secret: process.env.BUNNY_STREAM_WEBHOOK_SECRET,
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
    otherLibraryId: "999999",
  };
});

// Controllable stand-in for the Bunny API: the callback only ever names a video,
// and the authoritative details are read back through this.
const bunnyState = vi.hoisted(() => ({
  configured: true,
  details: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/bunny", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bunny")>();
  return {
    ...actual,
    isBunnyConfigured: () => bunnyState.configured,
    getBunnyVideoDetails: async () => bunnyState.details,
  };
});

/**
 * Redis is stubbed, and the stub is asserted rather than ignored.
 *
 * The route records every verified callback through the cache layer, which in a
 * real deployment is a shared key ("bunny:webhook:last") — writing that from a
 * test would overwrite what an operator reads on the admin panel. So the write
 * is captured here: the plumbing is still verified (a callback that is accepted
 * is a callback that is recorded), and nothing outside the test process is
 * touched.
 */
const recorded = vi.hoisted(() => ({ calls: [] as { key: string; value: unknown }[] }));

vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return {
    ...actual,
    cacheSet: async (key: string, value: unknown) => {
      recorded.calls.push({ key, value });
    },
    cacheGet: async () => null,
  };
});

import prisma from "@/lib/db";
import { computeBunnySignature, signBunnyWebhookTest } from "@/lib/bunny-webhook";
import { POST } from "@/app/api/webhooks/bunny/route";

// -----------------------------------------------------------------------------
// The fixture
// -----------------------------------------------------------------------------

const describeDB = process.env.DATABASE_URL ? describe : describe.skip;
const stamp = Date.now();

/** The guid a fresh Bunny upload carries, in the shape Bunny really issues. */
const bunnyVideoId = "b7f1c2d3-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
/** A guid that belongs to no row here — another creator's upload, or old. */
const unknownBunnyVideoId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const creatorId = `webhook-creator-${stamp}`;
const videoId = `webhook-video-${stamp}`;

/** A callback exactly as Bunny sends one: three fields, nothing else. */
function bunnyCallbackBody(options: {
  guid?: string;
  libraryId?: string;
  status?: number;
} = {}): string {
  return JSON.stringify({
    VideoLibraryId: Number(options.libraryId ?? env.libraryId),
    VideoGuid: options.guid ?? bunnyVideoId,
    Status: options.status ?? 3,
  });
}

/** POST a body to the real route handler with whatever headers are given. */
async function callWebhook(body: string, headers: Record<string, string> = {}) {
  const response = await POST(
    new Request("http://localhost/api/webhooks/bunny", {
      method: "POST",
      headers,
      body,
    }) as never
  );
  return { status: response.status, body: await response.json() };
}

/** A correctly signed callback, the way Bunny would deliver it. */
async function signedCallback(options: { guid?: string; libraryId?: string; status?: number } = {}) {
  const body = bunnyCallbackBody(options);
  return callWebhook(body, {
    "Content-Type": "application/json",
    "X-BunnyStream-Signature": computeBunnySignature(body, env.secret),
    "X-BunnyStream-Signature-Version": "v1",
    "X-BunnyStream-Signature-Algorithm": "hmac-sha256",
  });
}

describeDB("POST /api/webhooks/bunny (real route, real database)", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: creatorId,
        email: `${creatorId}@webhook.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Webhook Creator",
        role: "CREATOR",
      },
    });
    await prisma.video.create({
      data: {
        id: videoId,
        creatorId,
        title: "Webhook probe",
        bunnyVideoId,
        price: 1000,
        // Exactly how a fresh upload is written: accepted, not yet playable.
        isPublished: false,
        encodingStatus: 0,
        encodeProgress: 0,
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
    bunnyState.details = null;
    recorded.calls.length = 0;
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

  it("publishes the video the moment a signed Finished callback arrives", async () => {
    // Bunny reports length in seconds; 10 minutes clears the guidelines floor.
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };

    const response = await signedCallback({ status: 3 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", intent: "ready", matched: true });

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
    expect(video.duration).toBe(600);

    // The creator is told once, and told what happened.
    const notifications = await prisma.notification.findMany({ where: { userId: creatorId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("Webhook probe");
  });

  it("records the callback it acted on, so the admin panel can prove Bunny is reaching us", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };

    await signedCallback({ status: 3 });

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0].key).toBe("bunny:webhook:last");
    expect(recorded.calls[0].value).toMatchObject({
      status: 3,
      label: "Finished",
      intent: "ready",
      matched: true,
      published: true,
      videoId,
    });
  });

  it("is idempotent: a second identical callback does not notify twice", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };

    await signedCallback({ status: 3 });
    const second = await signedCallback({ status: 3 });

    expect(second.status).toBe(200);
    // Already published, so this callback changes nothing and says so.
    expect(second.body.matched).toBe(true);

    expect(await prisma.notification.count({ where: { userId: creatorId } })).toBe(1);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(true);
  });

  it("refuses an unsigned callback and leaves the video untouched", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };

    // No signature header at all. With a secret configured this is the case an
    // attacker can control completely, so it must not reach the lifecycle.
    const response = await callWebhook(bunnyCallbackBody());

    expect(response.status).toBe(401);
    expect(response.body.error).toBeDefined();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
  });

  it("refuses a body that no longer matches its signature", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };
    const body = bunnyCallbackBody();

    // The genuine digest, but the body has been edited — the exact attack the
    // raw-body-before-parse rule exists for.
    const response = await callWebhook(`${body} `, {
      "Content-Type": "application/json",
      "X-BunnyStream-Signature": computeBunnySignature(body, env.secret),
    });

    expect(response.status).toBe(401);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
  });

  it("refuses a callback signed with anything but the configured secret", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };
    const body = bunnyCallbackBody();

    const response = await callWebhook(body, {
      "Content-Type": "application/json",
      "X-BunnyStream-Signature": computeBunnySignature(body, "some-other-key"),
    });

    expect(response.status).toBe(401);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
  });

  it("ignores a callback from a different Stream library", async () => {
    bunnyState.details = { status: 4, encodeProgress: 100, length: 600 };

    // Signed with our secret (a secret shared across libraries, or a leaked
    // one), but about a video in somebody else's library.
    const response = await signedCallback({ libraryId: env.otherLibraryId, status: 3 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", intent: "ignore", matched: false });

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
  });

  it("accepts a callback for a video it does not track, and does nothing with it", async () => {
    // This is what a callback for a deleted row, or another environment's video,
    // looks like. 200 keeps Bunny from retrying a callback we cannot act on.
    const response = await signedCallback({ guid: unknownBunnyVideoId, status: 3 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", matched: false });

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
    expect(await prisma.notification.count({ where: { userId: creatorId } })).toBe(0);
  });

  it("answers the endpoint test's signed callback without publishing anything", async () => {
    // The self-test in the admin panel posts a Status 3 event for an id that
    // owns no video. It has to travel the publishing intent and still be
    // incapable of publishing — for every row, not just this one.
    const publishedBefore = await prisma.video.count({ where: { isPublished: true } });
    const { rawBody, headers } = signBunnyWebhookTest(env.secret, env.libraryId);

    const response = await callWebhook(rawBody, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", intent: "ready", matched: false });
    expect(await prisma.video.count({ where: { isPublished: true } })).toBe(publishedBefore);
  });

  it("keeps a still-encoding video private when Bunny reports progress", async () => {
    bunnyState.details = { status: 2, encodeProgress: 41 };

    const response = await signedCallback({ status: 2 });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe("progress");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.isPublished).toBe(false);
    expect(video.encodeProgress).toBe(41);
  });
});
