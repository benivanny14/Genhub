// =============================================================================
// GENHUB - The webhook's answer when the WORK fails
//
// The callback is the moment an encode becomes playable, so the cost of a
// lost one is a post that stays marked "Inachakatwa..." forever. The route used
// to answer 200 to everything, including the case where processing threw — which
// told Bunny the delivery was handled and quietly discarded the only event that
// would have published the video.
//
// What it answers now, and why the choice is safe:
//
//   * a transient failure gets a 5xx with `Retry-After`, so Bunny's own retry
//     becomes the recovery — the same failure answered 200 cannot recover at
//     all;
//   * a REPEATED callback is still processed, not swallowed. The route holds no
//     \"already seen\" state on purpose: the lifecycle underneath it is
//     idempotent (publishing twice changes nothing, and the notification is sent
//     once), and a route that swallowed a repeat would lose a transition whose
//     first delivery only half succeeded.
//
// No database and no network: the lifecycle service is stubbed, the signature is
// computed for real, and the environment variables are set before config loads.
// The database-backed half of this path — publishing, and one notification per
// finish — lives in webhook-publish.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  record: vi.fn(),
}));

// Set before `@/lib/config` is imported: it reads process.env once, at load.
const env = vi.hoisted(() => {
  process.env.BUNNY_STREAM_WEBHOOK_SECRET ||= "test-readonly-key-not-a-real-secret";
  process.env.BUNNY_STREAM_LIBRARY_ID ||= "760553";
  return {
    secret: process.env.BUNNY_STREAM_WEBHOOK_SECRET,
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
  };
});

vi.mock("@/lib/services/video-encoding.service", () => ({
  applyBunnyEncodingEvent: (...args: unknown[]) => mocks.apply(...args),
}));

vi.mock("@/lib/services/bunny-webhook.service", () => ({
  recordBunnyWebhookDelivery: (...args: unknown[]) => mocks.record(...args),
}));

import { computeBunnySignature } from "@/lib/bunny-webhook";
import { POST } from "@/app/api/webhooks/bunny/route";

const GUID = "657bb740-a71b-4529-a012-528021c31a92";

/** A signed callback exactly as Bunny sends one. */
function signedCallback(overrides: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify({
    VideoLibraryId: Number(env.libraryId),
    VideoGuid: GUID,
    Status: 3,
    ...overrides,
  });

  return new NextRequest("https://app.test/api/webhooks/bunny", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BunnyStream-Signature": computeBunnySignature(rawBody, env.secret),
    },
    body: rawBody,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(undefined);
  mocks.apply.mockResolvedValue({ matched: true, published: true, videoId: "video-1" });
});

describe("a callback the lifecycle could not process", () => {
  it("answers 5xx so Bunny retries, instead of claiming it was handled", async () => {
    // The failure this pins: Bunny delivered the event that would have published
    // a finished video, the write threw, and the route answered 200 — so the
    // delivery was recorded as done and nothing ever retried it.
    mocks.apply.mockRejectedValue(new Error("database is unreachable"));

    const response = await POST(signedCallback());
    const body = await response.json();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(body.status).toBe("retryable_error");
  });

  it("does not record a delivery that failed as though it had worked", async () => {
    // The admin panel reads this record to answer "is Bunny actually calling
    // us?" — a failed callback written as a successful delivery makes the switch
    // look healthy while the transition is being lost.
    mocks.apply.mockRejectedValue(new Error("database is unreachable"));

    await POST(signedCallback());

    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("publishes what the retry delivers", async () => {
    // The point of the 5xx: the next delivery is the one that works.
    mocks.apply.mockRejectedValueOnce(new Error("database is unreachable"));

    const failed = await POST(signedCallback());
    const retried = await POST(signedCallback());

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect((await retried.json()).matched).toBe(true);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
  });
});

describe("a callback Bunny delivers twice", () => {
  it("processes the repeat rather than swallowing it", async () => {
    // Deliberate: the route keeps no record of what it has seen. Swallowing a
    // repeat would be the wrong side of the trade — the first delivery may have
    // failed halfway — and the lifecycle underneath is idempotent, so processing
    // it again is cheap and cannot publish or notify twice.
    const first = await POST(signedCallback());
    const second = await POST(signedCallback());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);
  });

  it("records each delivery, so the panel counts what Bunny actually sent", async () => {
    await POST(signedCallback());
    await POST(signedCallback());

    expect(mocks.record).toHaveBeenCalledTimes(2);
  });
});
