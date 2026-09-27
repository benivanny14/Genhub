// =============================================================================
// GENHUB - Bunny Stream webhook verification
//
// The callback is the only thing that may flip a video to READY without a poll,
// so the two things that must never drift are:
//
//   1. an unsigned (or wrongly signed) body is refused, and
//   2. with no secret configured the route fails CLOSED in production, exactly
//      like the cron and HarakaPay rules next door.
//
// Signature verification is pure, so it is tested against the raw bytes without
// a server or a database.
// =============================================================================

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  bunnyWebhookIntent,
  bunnyWebhookLibraryId,
  bunnyWebhookVideoId,
  computeBunnySignature,
  parseBunnyWebhook,
  verifyBunnySignature,
} from "@/lib/bunny-webhook";

const SECRET = "read-only-key-abc123";
const BODY = JSON.stringify({
  VideoLibraryId: 133,
  VideoGuid: "657bb740-a71b-4529-a012-528021c31a92",
  Status: 3,
});
const SIGNATURE = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");

describe("computeBunnySignature", () => {
  it("is lowercase hex HMAC-SHA256 over the exact raw body", () => {
    expect(computeBunnySignature(BODY, SECRET)).toBe(SIGNATURE);
    expect(computeBunnySignature(BODY, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single byte of body or key changes", () => {
    expect(computeBunnySignature(`${BODY} `, SECRET)).not.toBe(SIGNATURE);
    expect(computeBunnySignature(BODY, `${SECRET}x`)).not.toBe(SIGNATURE);
  });
});

describe("verifyBunnySignature", () => {
  const base = { rawBody: BODY, signature: SIGNATURE, secret: SECRET, nodeEnv: "production" };

  it("accepts a correctly signed body", () => {
    expect(verifyBunnySignature(base).ok).toBe(true);
  });

  it("accepts the documented version/algorithm headers when present", () => {
    expect(
      verifyBunnySignature({ ...base, version: "v1", algorithm: "hmac-sha256" }).ok
    ).toBe(true);
  });

  it("accepts a body with no version/algorithm headers at all", () => {
    // Bunny's own docs list the headers, but a real delivery has been observed
    // without them. Requiring them would refuse a valid callback.
    expect(verifyBunnySignature({ ...base, version: null, algorithm: null }).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const check = verifyBunnySignature({
      ...base,
      rawBody: JSON.stringify({ VideoLibraryId: 133, VideoGuid: "x", Status: 3 }),
    });
    expect(check).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a wrong or missing signature", () => {
    expect(verifyBunnySignature({ ...base, signature: "deadbeef" }).ok).toBe(false);
    expect(verifyBunnySignature({ ...base, signature: "" }).ok).toBe(false);
  });

  it("rejects an unexpected version or algorithm", () => {
    expect(verifyBunnySignature({ ...base, version: "v2" })).toEqual({
      ok: false,
      reason: "bad-headers",
    });
    expect(verifyBunnySignature({ ...base, algorithm: "hmac-sha1" })).toEqual({
      ok: false,
      reason: "bad-headers",
    });
  });

  it("fails closed in production when no secret is configured", () => {
    expect(verifyBunnySignature({ ...base, secret: "" })).toEqual({
      ok: false,
      reason: "not-configured",
    });
  });

  it("allows an unsigned callback outside production, so local work needs no secret", () => {
    expect(verifyBunnySignature({ ...base, secret: "", nodeEnv: "development" }).ok).toBe(true);
  });
});

describe("parseBunnyWebhook + video id", () => {
  it("reads the guid from VideoGuid and the older VideoId spelling", () => {
    expect(bunnyWebhookVideoId(parseBunnyWebhook(BODY)!)).toBe(
      "657bb740-a71b-4529-a012-528021c31a92"
    );
    expect(bunnyWebhookVideoId({ VideoId: "  abc-123  " })).toBe("abc-123");
  });

  it("returns null for a body that is not a JSON object", () => {
    expect(parseBunnyWebhook("not json")).toBeNull();
    expect(parseBunnyWebhook("[1,2,3]")).toBeNull();
    expect(bunnyWebhookVideoId({})).toBeNull();
  });

  it("reads the library id as a string", () => {
    expect(bunnyWebhookLibraryId({ VideoLibraryId: 133 })).toBe("133");
    expect(bunnyWebhookLibraryId({})).toBeNull();
  });
});

describe("bunnyWebhookIntent", () => {
  it("maps the Stream status codes to what we should do", () => {
    expect(bunnyWebhookIntent({ Status: 3 })).toBe("ready"); // Finished
    expect(bunnyWebhookIntent({ Status: 4 })).toBe("playable"); // Resolution finished
    expect(bunnyWebhookIntent({ Status: 5 })).toBe("failed"); // Failed
    expect(bunnyWebhookIntent({ Status: 8 })).toBe("failed"); // Presigned upload failed
    expect(bunnyWebhookIntent({ Status: 0 })).toBe("progress");
    expect(bunnyWebhookIntent({ Status: 2 })).toBe("progress");
    expect(bunnyWebhookIntent({ Status: 7 })).toBe("progress");
  });

  it("understands string event names when they are present", () => {
    expect(bunnyWebhookIntent({ Event: "Video.Encoded" })).toBe("ready");
    expect(bunnyWebhookIntent({ Event: "video.ready" })).toBe("ready");
    expect(bunnyWebhookIntent({ Type: "Video.Failed" })).toBe("failed");
  });

  it("ignores a callback for a different library", () => {
    expect(bunnyWebhookIntent({ VideoLibraryId: 999, Status: 3 }, "133")).toBe("ignore");
    expect(bunnyWebhookIntent({ VideoLibraryId: 133, Status: 3 }, "133")).toBe("ready");
    // No library on the callback: act on it rather than silently dropping events.
    expect(bunnyWebhookIntent({ Status: 3 }, "133")).toBe("ready");
  });
});
