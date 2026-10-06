// =============================================================================
// GENHUB - Bunny Stream webhook verification
//
// The callback is the only thing that may flip a video to READY without a poll,
// so the two things that must never drift are:
//
//   1. an unsigned (or wrongly signed) body is refused, and
//   2. with no secret configured the route fails CLOSED in production, exactly
//      like the cron and SonicPesa rules next door.
//
// Signature verification is pure, so it is tested against the raw bytes without
// a server or a database.
// =============================================================================

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  BUNNY_WEBHOOK_TEST_GUID,
  bunnyWebhookIntent,
  bunnyWebhookLibraryId,
  bunnyWebhookVideoId,
  computeBunnySignature,
  describeBunnyWebhookStatus,
  inspectBunnyWebhookSecret,
  parseBunnyWebhook,
  signBunnyWebhookTest,
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

// -----------------------------------------------------------------------------
describe("describeBunnyWebhookStatus", () => {
  it("reads the status and its label together", () => {
    expect(describeBunnyWebhookStatus({ Status: 3 })).toEqual({ status: 3, label: "Finished" });
    expect(describeBunnyWebhookStatus({ Status: "5" })).toEqual({ status: 5, label: "Failed" });
  });

  it("does not invent a status the body never carried", () => {
    expect(describeBunnyWebhookStatus({})).toEqual({ status: null, label: null });
    expect(describeBunnyWebhookStatus({ Status: "soon" })).toEqual({ status: null, label: null });
  });

  it("still reports a code it has no label for", () => {
    // The panel must be able to show what Bunny sent even when the code is new
    // to us; a blank status is the answer that hides a change in their API.
    expect(describeBunnyWebhookStatus({ Status: 42 })).toEqual({ status: 42, label: null });
  });
});

// -----------------------------------------------------------------------------
describe("signBunnyWebhookTest", () => {
  it("signs the exact bytes it will post", () => {
    const test = signBunnyWebhookTest(SECRET, "133");

    expect(test.headers["X-BunnyStream-Signature"]).toBe(
      computeBunnySignature(test.rawBody, SECRET)
    );
    expect(
      verifyBunnySignature({
        rawBody: test.rawBody,
        signature: test.headers["X-BunnyStream-Signature"],
        secret: SECRET,
        nodeEnv: "production",
      }).ok
    ).toBe(true);
  });

  it("is a Finished event for an id no video can own", () => {
    // The test travels the publishing path, so the id it names must be
    // impossible to match — and impossible to poll as a real Bunny video.
    const payload = parseBunnyWebhook(signBunnyWebhookTest(SECRET, "133").rawBody)!;

    expect(payload.Status).toBe(3);
    expect(bunnyWebhookVideoId(payload)).toBe(BUNNY_WEBHOOK_TEST_GUID);
    // The same three fields Bunny sends, and nothing else. Extra keys would stop
    // this proving the handler can read a real delivery.
    expect(Object.keys(payload).sort()).toEqual(["Status", "VideoGuid", "VideoLibraryId"]);
  });

  it("names the library it is testing, so the endpoint judges it as its own", () => {
    const payload = parseBunnyWebhook(signBunnyWebhookTest(SECRET, "133").rawBody)!;

    expect(bunnyWebhookIntent(payload, "133")).toBe("ready");
    expect(bunnyWebhookIntent(payload, "999")).toBe("ignore");
  });

  it("sends a numeric library id, the way Bunny does", () => {
    const payload = parseBunnyWebhook(signBunnyWebhookTest(SECRET, "133").rawBody)!;
    expect(payload.VideoLibraryId).toBe(133);

    // No library configured: still a well-formed body, just not one that can be
    // mistaken for another library's callback.
    expect(parseBunnyWebhook(signBunnyWebhookTest(SECRET, "").rawBody)!.VideoLibraryId).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe("inspectBunnyWebhookSecret", () => {
  it("reports nothing configured when the secret is empty", () => {
    expect(inspectBunnyWebhookSecret({ secret: "" })).toEqual({
      configured: false,
      acceptsGenuine: false,
      refusesForged: false,
      matchesMainKey: false,
    });
  });

  it("proves the acceptance rule judged as production judges it", () => {
    // Deliberately not the ambient NODE_ENV: development accepts unsigned
    // callbacks, so a report built that way would read healthy for any value.
    const report = inspectBunnyWebhookSecret({ secret: SECRET });

    expect(report).toEqual({
      configured: true,
      acceptsGenuine: true,
      refusesForged: true,
      matchesMainKey: false,
    });
  });

  it("flags the library's main API key pasted in by mistake", () => {
    // Bunny signs callbacks with the Read-Only key. Handing over the main key
    // looks configured and refuses every real callback, which is why the value
    // is compared with the key the server already holds.
    const report = inspectBunnyWebhookSecret({ secret: SECRET, mainKey: SECRET });

    expect(report.configured).toBe(true);
    expect(report.matchesMainKey).toBe(true);
  });
});
