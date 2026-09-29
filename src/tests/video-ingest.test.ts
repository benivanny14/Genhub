// =============================================================================
// GENHUB - The ingest: token, worker, and what reaches Bunny
//
// The file has already crossed two providers by the time anything here runs, so
// every failure mode is silent from the outside unless it is asserted:
//
//   * a token that verifies for a different OBJECT or a different SLOT would let
//     one creator's unpublished file be pulled into somebody else's post;
//   * a token that verifies after its deadline is one that lives in logs
//     forever;
//   * a worker that reads the bucket before authorizing spends egress on a
//     request it was always going to refuse;
//   * a worker that forgets the AccessKey leaves an empty slot and a 401 that
//     says nothing.
//
// So these tests sign real tokens and drive the REAL worker handler — the module
// under worker/video-ingest is imported, not reimplemented.
// =============================================================================

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  signVideoIngestToken,
  videoIngestTokenPayload,
  videoIngestUrl,
  verifyVideoIngestToken,
} from "@/lib/video-ingest-token";
import worker from "../../worker/video-ingest/index";

const SECRET = "test-ingest-secret";
const KEY = "incoming/045b5638-6eff-45bb-8ef9-92479ebc3c3b";
const VIDEO_ID = "045b5638-6eff-45bb-8ef9-92479ebc3c3b";
const OTHER_VIDEO_ID = "ce2ae11d-0f6a-40e5-a629-7995f97ecaaf";
const OTHER_KEY = "incoming/ce2ae11d-0f6a-40e5-a629-7995f97ecaaf";
const EXPIRES = Math.floor(Date.now() / 1000) + 3_600;

afterEach(() => {
  vi.unstubAllGlobals();
});

const urlOf = () =>
  new URL(
    videoIngestUrl({
      baseUrl: "https://genhub-ingest.example.workers.dev",
      key: KEY,
      videoId: VIDEO_ID,
      expiresAt: EXPIRES,
      token: "t",
    })
  );

function bucketWith(body: ReadableStream | null, size = 3) {
  return {
    get: vi.fn(async () => (body ? { body, size } : null)),
  };
}

function envWith(bucket: unknown) {
  return {
    BUCKET: bucket as never,
    VIDEO_INGEST_SECRET: SECRET,
    BUNNY_STREAM_API_KEY: "test-library-key",
    BUNNY_STREAM_LIBRARY_ID: "760553",
  };
}

async function signedRequest(): Promise<Request> {
  const token = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
  const url = new URL(
    videoIngestUrl({
      baseUrl: "https://genhub-ingest.example.workers.dev",
      key: KEY,
      videoId: VIDEO_ID,
      expiresAt: EXPIRES,
      token,
    })
  );
  return new Request(url, { method: "POST" });
}

// =============================================================================
// The token
// =============================================================================

describe("video ingest token", () => {
  it("signs one versioned shape naming both the object and the slot", () => {
    expect(videoIngestTokenPayload(KEY, VIDEO_ID, EXPIRES)).toBe(`v1:${KEY}:${VIDEO_ID}:${EXPIRES}`);
  });

  it("is deterministic hex, so the worker recomputes rather than stores", async () => {
    const once = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    const again = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    expect(once).toBe(again);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies up to the deadline, inclusive, and not one second past it", async () => {
    const token = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    const base = { secret: SECRET, key: KEY, videoId: VIDEO_ID, expiresAt: EXPIRES, token };

    await expect(verifyVideoIngestToken({ ...base, nowSeconds: EXPIRES })).resolves.toBe(true);
    await expect(verifyVideoIngestToken({ ...base, nowSeconds: EXPIRES - 1 })).resolves.toBe(true);
    await expect(verifyVideoIngestToken({ ...base, nowSeconds: EXPIRES + 1 })).resolves.toBe(false);
  });

  it("refuses a token for another object", async () => {
    const token = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    await expect(
      verifyVideoIngestToken({
        secret: SECRET,
        key: OTHER_KEY,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES - 1,
      })
    ).resolves.toBe(false);
  });

  it("refuses a token for another video slot", async () => {
    // The attack this exists to stop: a token that names a key but not a slot
    // could be pointed at somebody else's post.
    const token = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    await expect(
      verifyVideoIngestToken({
        secret: SECRET,
        key: KEY,
        videoId: OTHER_VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES - 1,
      })
    ).resolves.toBe(false);
  });

  it("refuses a token signed with a different secret, and an empty one", async () => {
    const token = await signVideoIngestToken("other-secret", KEY, VIDEO_ID, EXPIRES);
    const base = { key: KEY, videoId: VIDEO_ID, expiresAt: EXPIRES, nowSeconds: EXPIRES - 1 };

    await expect(verifyVideoIngestToken({ ...base, secret: SECRET, token })).resolves.toBe(false);
    await expect(verifyVideoIngestToken({ ...base, secret: SECRET, token: "" })).resolves.toBe(false);
    await expect(verifyVideoIngestToken({ ...base, secret: "", token })).resolves.toBe(false);
  });

  it("refuses a tampered token and an unparseable deadline", async () => {
    const token = await signVideoIngestToken(SECRET, KEY, VIDEO_ID, EXPIRES);
    const base = { secret: SECRET, key: KEY, videoId: VIDEO_ID, nowSeconds: EXPIRES - 1 };

    // The LAST character is flipped, and to a value it demonstrably is not: a
    // fixed replacement ("f" + the rest) is a no-op whenever the token happens to
    // start with that letter, which made this test pass five times in six.
    const flipped = token.endsWith("a") ? "b" : "a";
    const tampered = `${token.slice(0, -1)}${flipped}`;
    expect(tampered).not.toBe(token);

    await expect(
      verifyVideoIngestToken({ ...base, expiresAt: EXPIRES, token: tampered })
    ).resolves.toBe(false);
    await expect(
      verifyVideoIngestToken({ ...base, expiresAt: Number.NaN, token })
    ).resolves.toBe(false);
  });

  it("puts the ingest endpoint on the URL without doubling a slash", () => {
    const withSlash = videoIngestUrl({
      baseUrl: "https://genhub-ingest.example.workers.dev/",
      key: KEY,
      videoId: VIDEO_ID,
      expiresAt: EXPIRES,
      token: "t",
    });
    expect(new URL(withSlash).pathname).toBe("/ingest");
    expect(urlOf().pathname).toBe("/ingest");
  });
});

// =============================================================================
// The worker
// =============================================================================

describe("the ingest worker", () => {
  it("answers liveness without printing a secret", async () => {
    const res = await worker.fetch(
      new Request("https://w.example.workers.dev/health"),
      envWith(bucketWith(null))
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      bucketConfigured: true,
      secretConfigured: true,
      bunnyConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("only accepts POST on /ingest", async () => {
    const get = await worker.fetch(new Request(urlOf(), { method: "GET" }), envWith(bucketWith(null)));
    const nowhere = await worker.fetch(
      new Request("https://w.example.workers.dev/nope", { method: "POST" }),
      envWith(bucketWith(null))
    );

    expect(get.status).toBe(405);
    expect(nowhere.status).toBe(404);
  });

  it("refuses a request with no token before it looks at the bucket", async () => {
    const bucket = bucketWith(null);
    const res = await worker.fetch(new Request(urlOf(), { method: "POST" }), envWith(bucket));

    expect(res.status).toBe(401);
    // The point: no bucket read happens for a request that was never authorized.
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("refuses a token signed with another secret, still without reading the bucket", async () => {
    const bucket = bucketWith(null);
    const token = await signVideoIngestToken("wrong-secret", KEY, VIDEO_ID, EXPIRES);
    const url = new URL(
      videoIngestUrl({
        baseUrl: "https://genhub-ingest.example.workers.dev",
        key: KEY,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
      })
    );

    const res = await worker.fetch(new Request(url, { method: "POST" }), envWith(bucket));
    expect(res.status).toBe(401);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("reports a missing object as not uploaded, once authorized", async () => {
    const res = await worker.fetch(
      await signedRequest(),
      envWith(bucketWith(null))
    );
    expect(res.status).toBe(404);
  });

  it("says which side is misconfigured when its own secret is absent", async () => {
    const res = await worker.fetch(new Request(urlOf(), { method: "POST" }), {
      BUCKET: bucketWith(null) as never,
      BUNNY_STREAM_API_KEY: "k",
      BUNNY_STREAM_LIBRARY_ID: "760553",
    });
    expect(res.status).toBe(500);
  });

  it("PUTs the streamed object to the reserved slot with the library key", async () => {
    const stream = new ReadableStream();
    const bucket = bucketWith(stream, 1234);
    const bunny = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal("fetch", bunny);

    const res = await worker.fetch(await signedRequest(), envWith(bucket));

    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(KEY);

    const [target, init] = bunny.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(`https://video.bunnycdn.com/library/760553/videos/${VIDEO_ID}`);
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.AccessKey).toBe("test-library-key");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    // Streamed, not buffered: the body is the object's stream itself.
    expect(init.body).toBe(stream);
  });

  it("passes Bunny's refusal back with its own words", async () => {
    const bunny = vi.fn(
      async () => new Response('{"message":"Authentication has been denied"}', { status: 401 })
    );
    vi.stubGlobal("fetch", bunny);

    const res = await worker.fetch(
      await signedRequest(),
      envWith(bucketWith(new ReadableStream()))
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body.bunnyStatus).toBe(401);
    expect(String(body.bunnyBody)).toContain("Authentication has been denied");
  });
});
