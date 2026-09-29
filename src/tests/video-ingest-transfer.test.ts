// =============================================================================
// GENHUB - The ingest's own transfer: bucket -> Bunny, in slices
//
// The step that failed at 100% on 2026-09-29 was not a creator's upload and not
// a Bunny refusal: it was a Worker running code nobody had deployed, throwing on
// a body Cloudflare caps at 100 MB, and answering with an HTML error page. The
// move now runs in this application's own service, and what these tests pin is
// the part that has to be right for it to be worth anything:
//
//   * the whole object moves, and no byte is sent twice — the offset always comes
//     from Bunny's own answer;
//   * a call that runs out of time says PENDING, with how far it got, instead of
//     dying at the platform's guillotine with nothing to read;
//   * a transfer that was cut mid-slice is retried from the offset Bunny
//     confirmed, not from the offset this side assumed;
//   * a finished transfer removes the staging copy, and a repeat call on a
//     finished video answers ready rather than "upload it again".
//
// Every provider is faked, and the fakes are keyed on the URLs the service really
// builds — a fake that answers the wrong request would hide exactly the bug these
// tests exist to catch.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis is stubbed rather than reached: what matters here is only whether the
// upload's URL was remembered and dropped, and a test that wrote
// `bunny:tus:*` keys into the shared Redis would be a test with a side effect on
// production data.
const cache = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: cache.get,
  cacheSet: cache.set,
  cacheDel: cache.del,
}));

// The library lookup is the one call that would go to Bunny outside the TUS
// protocol, so it is mocked per test.
const stored = vi.hoisted(() => ({ bytes: 0 }));

vi.mock("@/lib/bunny", () => ({
  getBunnyVideoDetails: vi.fn(async () => ({ storageSize: stored.bytes })),
}));

import {
  INGEST_BUDGET_MS,
  INGEST_CHUNK_BYTES,
  ingestUploadedVideo,
} from "@/lib/services/video-ingest.service";

const VIDEO_ID = "045b5638-6eff-45bb-8ef9-92479ebc3c3b";
const KEY = `incoming/${VIDEO_ID}`;
const R2_HOST = "5492c7dfae50c7be6388a2e6558da365.r2.cloudflarestorage.com";
const BUNNY_TUS = "https://video.bunnycdn.com/tusupload";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * The bucket and the library, as the service addresses them.
 *
 * The bucket is recognised by its host, the library by its endpoint, and the
 * upload resource by the session path Bunny hands out — the same three shapes the
 * real requests have, so a request the service builds wrongly is answered by the
 * fake the way a provider would answer it: not at all.
 */
function fakeProviders(options: {
  objectBytes?: number | null;
  /** Bunny's answer to a HEAD of the session. */
  bunnyOffset?: number;
  slices?: number[];
  createStatus?: number;
  createBody?: string;
  patchStatus?: number;
  /** Statuses Bunny answers with before it accepts a slice, in order. */
  patchStatuses?: number[];
  throwFirstPatch?: boolean;
}) {
  const calls: Call[] = [];
  const slices = options.slices ?? [];
  let sliceIndex = 0;
  let bunnyOffset = options.bunnyOffset ?? 0;
  const pendingStatuses = [...(options.patchStatuses ?? [])];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, headers, body: init?.body });

    // ---- the library's resumable endpoint -------------------------------
    if (url === BUNNY_TUS) {
      if (options.createStatus && options.createStatus >= 400) {
        return new Response(options.createBody ?? '{"message":"refused"}', {
          status: options.createStatus,
        });
      }
      return new Response("{}", {
        status: 201,
        headers: { location: "/tusupload/session-1" },
      });
    }

    if (url.startsWith(`${BUNNY_TUS}/`)) {
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "upload-offset": String(bunnyOffset) },
        });
      }
      if (options.throwFirstPatch && sliceIndex === 0) {
        sliceIndex += 1;
        throw new TypeError("network down");
      }
      const pendingStatus = pendingStatuses.shift();
      if (pendingStatus) {
        return new Response('{"message":"File is currently being updated"}', {
          status: pendingStatus,
        });
      }
      if (options.patchStatus && options.patchStatus >= 400) {
        return new Response('{"message":"refused"}', { status: options.patchStatus });
      }
      bunnyOffset += slices[sliceIndex] ?? 0;
      sliceIndex += 1;
      // A 204 with a body throws inside the fake, which would look like Bunny
      // refusing every slice.
      return new Response(null, {
        status: 204,
        headers: { "upload-offset": String(bunnyOffset) },
      });
    }

    // ---- the bucket ------------------------------------------------------
    if (url.includes(R2_HOST)) {
      const size = options.objectBytes ?? null;
      if (size === null) return new Response("", { status: 404 });

      if (method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": String(size) } });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET") {
        const range = headers.Range ?? headers.range ?? "";
        const match = /bytes=(\d+)-(\d+)/.exec(range);
        const length = match ? Number(match[2]) - Number(match[1]) + 1 : size;
        return new Response(new Uint8Array(length), { status: 206 });
      }
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return {
    calls,
    bunny: () => calls.filter((call) => call.url.startsWith(BUNNY_TUS)),
    patches: () => calls.filter((call) => call.url.startsWith(BUNNY_TUS) && call.method === "PATCH"),
    deletes: () => calls.filter((call) => call.method === "DELETE"),
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  cache.get.mockReset().mockResolvedValue(null);
  cache.set.mockReset().mockResolvedValue(undefined);
  cache.del.mockReset().mockResolvedValue(undefined);
  stored.bytes = 0;
});

describe("the ingest's own transfer", () => {
  it("moves the whole object in one slice and reports Bunny holding it", async () => {
    const bucket = fakeProviders({ objectBytes: 1_000, slices: [1_000] });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome).toMatchObject({ ok: true, bytes: 1_000 });

    const create = bucket.calls.find((call) => call.url === BUNNY_TUS);
    expect(create?.method).toBe("POST");
    // The length is declared before a byte moves: TUS requires it, and it is what
    // makes Bunny's own "complete" mean something.
    expect(create?.headers["Upload-Length"]).toBe("1000");
    expect(create?.headers.LibraryId).toBeTruthy();
    expect(create?.headers.AuthorizationSignature).toMatch(/^[0-9a-f]{64}$/);

    const patch = bucket.patches()[0];
    expect(patch.headers["Upload-Offset"]).toBe("0");
    expect(patch.headers["Content-Type"]).toBe("application/offset+octet-stream");
    // Bunny revalidates the signature on EVERY request: a PATCH without these is
    // answered 400 "Library ID missing or invalid", measured live.
    expect(patch.headers.LibraryId).toBe(create?.headers.LibraryId);
    expect(patch.headers.AuthorizationSignature).toBe(create?.headers.AuthorizationSignature);

    // The bucket was read by RANGE, so a large file is never held whole.
    const read = bucket.calls.find((call) => call.method === "GET");
    expect(read?.headers.Range).toBe("bytes=0-999");
  });

  it("deletes the staging copy and forgets the upload once Bunny holds the file", async () => {
    const bucket = fakeProviders({ objectBytes: 512, slices: [512] });

    await ingestUploadedVideo(VIDEO_ID);

    // Left behind, a copy is storage billed for a file that is already in the
    // library — one dead 192 MB object per failed attempt, in the live bucket.
    expect(bucket.deletes()).toHaveLength(1);
    expect(cache.del).toHaveBeenCalledWith(`bunny:tus:${VIDEO_ID}`);
  });

  it("remembers the upload's URL, because Bunny identifies a transfer by it", async () => {
    const bucket = fakeProviders({ objectBytes: 512, slices: [512] });

    await ingestUploadedVideo(VIDEO_ID);

    expect(cache.set).toHaveBeenCalledWith(
      `bunny:tus:${VIDEO_ID}`,
      "https://video.bunnycdn.com/tusupload/session-1",
      expect.any(Number)
    );

    // A RELATIVE Location resolved against the API host — used as it arrives it
    // throws "Failed to parse URL".
    expect(bucket.patches()[0].url).toBe("https://video.bunnycdn.com/tusupload/session-1");
  });

  it("continues from the offset Bunny reports, and reads only what is missing", async () => {
    cache.get.mockResolvedValue("https://video.bunnycdn.com/tusupload/session-1");
    const bucket = fakeProviders({
      objectBytes: 1_000,
      bunnyOffset: 600,
      slices: [400],
    });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome.ok).toBe(true);
    expect(bucket.calls.some((call) => call.url === BUNNY_TUS && call.method === "POST")).toBe(
      false
    );
    const read = bucket.calls.find((call) => call.method === "GET");
    expect(read?.headers.Range).toBe("bytes=600-999");
    expect(bucket.patches()[0].headers["Upload-Offset"]).toBe("600");
  });

  it("answers pending, with its offset, when the call runs out of time", async () => {
    // A call whose budget expired before it started, which is what the end of a
    // long transfer looks like — and the case that must never be reported as a
    // failure, because Bunny keeps what it has.
    const bucket = fakeProviders({ objectBytes: 10_000, bunnyOffset: 4_000, slices: [1_000] });

    const outcome = await ingestUploadedVideo(VIDEO_ID, new Date(Date.now() - INGEST_BUDGET_MS * 2));

    expect(outcome).toMatchObject({
      ok: false,
      pending: true,
      uploadedBytes: 4_000,
      totalBytes: 10_000,
    });
    // Nothing was sent and nothing was deleted: the file is mid-flight, not lost.
    expect(bucket.patches()).toHaveLength(0);
    expect(bucket.deletes()).toHaveLength(0);
  });

  it("retries a slice the connection dropped, from the offset Bunny confirmed", async () => {
    const bucket = fakeProviders({ objectBytes: 800, slices: [800], throwFirstPatch: true });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome.ok).toBe(true);
    // Twice: the one that threw, and the one that followed the offset Bunny still
    // reported. Reusing the offset this side assumed is how a slice lands in the
    // middle of a creator's video.
    const patches = bucket.patches();
    expect(patches).toHaveLength(2);
    expect(patches.map((patch) => patch.headers["Upload-Offset"])).toEqual(["0", "0"]);
    expect(bucket.calls.filter((call) => call.method === "HEAD" && call.url.startsWith(`${BUNNY_TUS}/`)))
      .toHaveLength(2);
  });

  it("waits out a status Bunny says will pass, instead of throwing the file away", async () => {
    // MEASURED, on the first live run of this transfer: Bunny answered
    // `423 File is currently being updated. Please try again later`. Read as a
    // refusal, that abandons a file which is already halfway across two
    // providers — and the direct-to-Bunny path in this codebase learned the same
    // lesson once already (TRANSIENT_4XX, lib/upload-error.ts).
    const bucket = fakeProviders({
      objectBytes: 900,
      slices: [900],
      patchStatuses: [423, 500],
    });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome).toMatchObject({ ok: true, bytes: 900 });
    // Three attempts: two that Bunny asked to be repeated, and the one that
    // landed — every one of them at the offset Bunny still reported.
    expect(bucket.patches().map((patch) => patch.headers["Upload-Offset"])).toEqual([
      "0",
      "0",
      "0",
    ]);
  }, 30_000);

  it("reports a temporary provider status as pending when the call runs out of retries", async () => {
    const bucket = fakeProviders({
      objectBytes: 900,
      bunnyOffset: 100,
      slices: [800],
      patchStatuses: [423, 423, 423, 423, 423],
    });

    const outcome = await ingestUploadedVideo(VIDEO_ID, new Date(Date.now() - INGEST_BUDGET_MS + 12_000));

    // Pending, not failed: the next call tries again, which is exactly what
    // "please try again later" asks for, and the creator is not told their
    // upload died while it is still moving.
    expect(outcome).toMatchObject({ ok: false, pending: true, uploadedBytes: 100, totalBytes: 900 });
    expect(outcome.detail).toContain("423");
    expect(bucket.deletes()).toHaveLength(0);
  }, 30_000);

  it("passes Bunny's refusal back with its own words instead of retrying it", async () => {
    const bucket = fakeProviders({
      objectBytes: 300,
      createStatus: 401,
      createBody: '{"message":"Authentication has been denied"}',
    });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("refused");
    expect(outcome.detail).toContain("Authentication has been denied");
    // Nothing was sent to a library that had already refused us.
    expect(bucket.patches()).toHaveLength(0);
  });

  it("says the upload never arrived when the bucket has nothing and Bunny has nothing", async () => {
    fakeProviders({ objectBytes: null });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome).toMatchObject({ ok: false, reason: "not-uploaded" });
  });

  it("treats a video Bunny already holds as ready, not as a missing upload", async () => {
    // The repeat case that matters: a call that finished the transfer and had its
    // answer lost on the way back finds no object (the copy is deleted on
    // success) and would otherwise tell the creator to upload two gigabytes again.
    fakeProviders({ objectBytes: null });
    stored.bytes = 192 * 1024 * 1024;

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome).toMatchObject({ ok: true, bytes: 192 * 1024 * 1024 });
  });

  it("sends a file larger than one slice as several, each at the right offset", async () => {
    const total = INGEST_CHUNK_BYTES * 2 + 5;
    const bucket = fakeProviders({
      objectBytes: total,
      slices: [INGEST_CHUNK_BYTES, INGEST_CHUNK_BYTES, 5],
    });

    const outcome = await ingestUploadedVideo(VIDEO_ID);

    expect(outcome.ok).toBe(true);
    expect(bucket.patches().map((patch) => patch.headers["Upload-Offset"])).toEqual([
      "0",
      String(INGEST_CHUNK_BYTES),
      String(INGEST_CHUNK_BYTES * 2),
    ]);
    expect(bucket.calls.filter((call) => call.method === "GET").map((call) => call.headers.Range)).toEqual([
      `bytes=0-${INGEST_CHUNK_BYTES - 1}`,
      `bytes=${INGEST_CHUNK_BYTES}-${INGEST_CHUNK_BYTES * 2 - 1}`,
      `bytes=${INGEST_CHUNK_BYTES * 2}-${total - 1}`,
    ]);
  });
});
