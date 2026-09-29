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

import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { INGEST_BUDGET_MS } from "@/lib/services/video-ingest.service";
import {
  signVideoIngestToken,
  videoIngestTokenPayload,
  videoIngestUrl,
  verifyVideoIngestToken,
} from "@/lib/video-ingest-token";
import worker, { CHUNK_BYTES } from "../../worker/video-ingest/index";

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

/**
 * A fake bucket: `head` for the LENGTH (metadata, no body), `get` for the
 * slices.
 *
 * The two are separate calls because the Worker asks for them separately — an
 * upload has to declare how long it is before the first byte moves, which is a
 * question about metadata, not about bytes.
 */
function bucketWith(body: ReadableStream | null, size = 3) {
  return {
    head: vi.fn(async () => (body ? { size } : null)),
    get: vi.fn(async (_key: string, options?: { range?: { offset: number; length: number } }) =>
      body ? { body, size: options?.range?.length ?? size } : null
    ),
  };
}

interface BunnyCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * The Bunny side of a TUS upload, as three requests: create, HEAD, PATCH.
 *
 * `slices` is the size of each PATCH's body, in order, so the fake can report
 * the offsets a real server would — that is the value the Worker uses to decide
 * how far it has got, so it cannot be faked without faking it here.
 */
function fakeBunny(options: {
  slices: number[];
  offsetStart?: number;
  createStatus?: number;
  createBody?: string;
  location?: string | null;
  patchStatus?: number;
  throwOnPatch?: boolean;
}) {
  const calls: BunnyCall[] = [];
  let offset = options.offsetStart ?? 0;
  let sliceIndex = 0;

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, headers, body: init?.body });

    if (url.endsWith("/tusupload")) {
      const outHeaders: Record<string, string> = {};
      if (options.location !== null) outHeaders.location = options.location ?? "/tusupload/probe-session";
      return new Response(options.createBody ?? "{}", {
        status: options.createStatus ?? 201,
        headers: outHeaders,
      });
    }

    if (method === "HEAD") {
      return new Response("", { status: 200, headers: { "upload-offset": String(offset) } });
    }

    if (options.throwOnPatch) throw new TypeError("network down");
    if (options.patchStatus && options.patchStatus >= 400) {
      return new Response('{"message":"refused"}', { status: options.patchStatus });
    }

    offset += options.slices[sliceIndex] ?? 0;
    sliceIndex += 1;
    // A 204 must carry no body at all: `new Response("", {status: 204})` throws
    // inside the fake, which would look like Bunny refusing every chunk.
    return new Response(null, { status: 204, headers: { "upload-offset": String(offset) } });
  });

  vi.stubGlobal("fetch", impl);
  return { calls, patches: () => calls.filter((call) => call.method === "PATCH") };
}

/** What Bunny's signature must be, computed here from the docs' own rule. */
const tusSignature = (libraryId: string, apiKey: string, expire: string, videoId: string) =>
  createHash("sha256").update(`${libraryId}${apiKey}${expire}${videoId}`).digest("hex");

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

  it("opens a TUS upload for the reserved slot and sends the object through it", async () => {
    const stream = new ReadableStream();
    const bucket = bucketWith(stream, 1234);
    const bunny = fakeBunny({ slices: [1234] });

    const res = await worker.fetch(await signedRequest(), envWith(bucket));
    expect(res.status).toBe(200);

    const create = bunny.calls[0];
    expect(create.url).toBe("https://video.bunnycdn.com/tusupload");
    expect(create.method).toBe("POST");
    // The slot and the length, declared before a byte moves: TUS requires both.
    expect(create.headers.VideoId).toBe(VIDEO_ID);
    expect(create.headers.LibraryId).toBe("760553");
    expect(create.headers["Upload-Length"]).toBe("1234");
    expect(create.headers["Tus-Resumable"]).toBe("1.0.0");
    // Bunny's own rule, recomputed here: library id, key, deadline, video id.
    expect(create.headers.AuthorizationSignature).toBe(
      tusSignature("760553", "test-library-key", create.headers.AuthorizationExpire, VIDEO_ID)
    );
    // Metadata is required and base64-encoded.
    expect(create.headers["Upload-Metadata"]).toContain("filetype " + Buffer.from("video/mp4").toString("base64"));

    // The Location Bunny returns is RELATIVE, so the PATCH has to be addressed
    // against the API host rather than used as it arrives.
    const patch = bunny.patches()[0];
    expect(patch.url).toBe("https://video.bunnycdn.com/tusupload/probe-session");
    expect(patch.headers["Upload-Offset"]).toBe("0");
    expect(patch.headers["Content-Type"]).toBe("application/offset+octet-stream");
    // Bunny revalidates the signature on EVERY request, so a PATCH without these
    // is answered 400 "Library ID missing or invalid" — measured live.
    expect(patch.headers.LibraryId).toBe("760553");
    expect(patch.headers.AuthorizationSignature).toBe(create.headers.AuthorizationSignature);
    // Streamed, not buffered: the body is the bucket's own slice.
    expect(patch.body).toBe(stream);

    await expect(res.json()).resolves.toMatchObject({ ok: true, bytes: 1234, chunks: 1 });
  });

  it("sends the file in pieces, each under the cap that made one PUT impossible", async () => {
    // The reason this Worker exists in this shape: Cloudflare caps a subrequest's
    // request body at 100 MB, and a creator's 192 MB file made the old single PUT
    // throw in 1.8 seconds before Bunny was even reached.
    expect(CHUNK_BYTES).toBeLessThan(100 * 1024 * 1024);

    const total = CHUNK_BYTES + 10;
    const bucket = bucketWith(new ReadableStream(), total);
    const bunny = fakeBunny({ slices: [CHUNK_BYTES, 10] });

    const res = await worker.fetch(await signedRequest(), envWith(bucket));
    expect(res.status).toBe(200);

    // Read by RANGE: the file is never held in the Worker's memory.
    expect(bucket.get.mock.calls.map((call) => call[1])).toEqual([
      { range: { offset: 0, length: CHUNK_BYTES } },
      { range: { offset: CHUNK_BYTES, length: 10 } },
    ]);

    const patches = bunny.patches();
    expect(patches.map((patch) => patch.headers["Upload-Offset"])).toEqual([
      "0",
      String(CHUNK_BYTES),
    ]);
    await expect(res.json()).resolves.toMatchObject({ ok: true, bytes: total, chunks: 2 });
  });

  it("continues from the offset Bunny already holds instead of starting again", async () => {
    // What makes a second attempt cheap: a first one that was cut short left its
    // bytes at Bunny, and Bunny is asked where they end rather than trusting
    // anything this Worker would have had to remember.
    const total = CHUNK_BYTES + 10;
    const bucket = bucketWith(new ReadableStream(), total);
    const bunny = fakeBunny({ slices: [10], offsetStart: CHUNK_BYTES });

    await worker.fetch(await signedRequest(), envWith(bucket));

    expect(bucket.get.mock.calls.map((call) => call[1])).toEqual([
      { range: { offset: CHUNK_BYTES, length: 10 } },
    ]);
    expect(bunny.patches()).toHaveLength(1);
    expect(bunny.patches()[0].headers["Upload-Offset"]).toBe(String(CHUNK_BYTES));
  });

  it("passes Bunny's refusal back with its own words", async () => {
    const bunny = fakeBunny({
      slices: [3],
      createStatus: 401,
      createBody: '{"message":"Authentication has been denied"}',
    });

    const res = await worker.fetch(
      await signedRequest(),
      envWith(bucketWith(new ReadableStream()))
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body.bunnyStatus).toBe(401);
    expect(String(body.bunnyBody)).toContain("Authentication has been denied");
    // Nothing was sent to a library that had already refused us.
    expect(bunny.patches()).toHaveLength(0);
  });

  it("answers JSON when the connection to Bunny dies, rather than throwing", async () => {
    // The old code let this escape as an exception, and Cloudflare answered the
    // caller with an HTML "Worker threw exception" page: the app could only say
    // "could not be handed to the video service", and the real reason existed
    // nowhere a creator or an operator could read it.
    fakeBunny({ slices: [3], throwOnPatch: true });

    const res = await worker.fetch(
      await signedRequest(),
      envWith(bucketWith(new ReadableStream(), 3))
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(String(body.bunnyBody)).toMatch(/network down/);
  });

  it("stops rather than pretending a refusal was a transfer", async () => {
    const bunny = fakeBunny({ slices: [3], patchStatus: 415 });

    const res = await worker.fetch(
      await signedRequest(),
      envWith(bucketWith(new ReadableStream(), 3))
    );

    expect(res.status).toBe(502);
    // One chunk was refused, so the loop stopped there instead of hammering the
    // same offset and spending three requests on a foregone conclusion.
    expect(bunny.patches()).toHaveLength(1);
  });
});

// =============================================================================
// The caller's budget, which has to lose to the route's own
// =============================================================================

describe("the ingest route's patience", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "videos", "ingest", "route.ts"),
    "utf8"
  );

  it("gives up before the function does, so the creator is told a reason", () => {
    // Both were 60s, which meant the abort and the kill landed on the same
    // instant: the request died with no body, the page could only say "Network
    // error while preparing the video", and the one step that knows what went
    // wrong reported nothing. The abort has to come FIRST.
    const maxDuration = Number(route.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/)?.[1]);

    expect(maxDuration).toBeGreaterThan(0);
    expect(INGEST_BUDGET_MS).toBeLessThan(maxDuration * 1000);
  });

  it("still leaves the abort room to serialise an answer", () => {
    // Not merely less than maxDuration: it has to be far enough under it that
    // the route can log, build the response and flush it after the abort fires.
    const maxDuration = Number(route.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/)![1]);
    expect(maxDuration * 1000 - INGEST_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("answers an unfinished transfer as something the page continues, not a failure", () => {
    // The shape IS the contract here: a file that is halfway across two providers
    // is not a failed upload, and a route that answered it as one would send a
    // creator's two gigabytes again for a move that costs them nothing. Asserted
    // against the route's source because that is where the branch lives — the
    // outcome itself is covered in tests/video-ingest-transfer.test.ts.
    expect(route).toMatch(/outcome\.pending/);
    expect(route).toMatch(/ready:\s*false/);
  });
});
