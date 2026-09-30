// =============================================================================
// GENHUB - Tests for the browser's direct Bunny TUS uploader
//
// The video transfer is the one path where a failure is invisible: the browser
// has the file, the server has no bytes, and the creator's only evidence is a
// progress bar that stopped. These tests pin the four rules that decide whether
// that bar recovers or restarts:
//
//   1. The offset Bunny REPORTS is the one used, never the offset we sent — a
//      transfer that trusts its own arithmetic after a half-delivered PATCH
//      writes the wrong slice into the middle of the file.
//   2. A connection that dies is retried, and the retry resumes from Bunny's
//      recorded byte instead of sending the chunk again from zero.
//   3. A permanent refusal (a 4xx Bunny ANSWERED) is not retried — five
//      attempts at a request Bunny has already rejected is four wasted minutes
//      of a creator's data.
//   4. Nothing is sent at all for a file the server would refuse: the 2 GB
//      ceiling is checked before a session is created, so no Bunny slot is
//      reserved for a file that can never arrive.
//
// `window` is stubbed because this module is browser code compiled for Node:
// it schedules retry delays on `window.setTimeout`, and the fake timers make a
// 7.5-second retry ladder run instantly.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VIDEO_BYTES,
  VIDEO_UPLOAD_FLOOR_BPS,
  VIDEO_UPLOAD_MAX_ATTEMPTS,
  VIDEO_UPLOAD_MAX_CHUNK_BYTES,
  VIDEO_UPLOAD_READ_PROBE_BYTES,
  VIDEO_UPLOAD_READ_TIMEOUT_MS,
  VIDEO_UPLOAD_TARGET_CHUNK_MS,
  VIDEO_UPLOAD_TUS_ENDPOINT,
  VideoUploadError,
  assertFileReadable,
  chunkBytesFor,
  chunkTimeoutMs,
  completeVideoUpload,
  measureRate,
  openVideoUpload,
  uploadVideoFile,
  videoFileSizeError,
  type OpenedVideoUpload,
} from "@/lib/video-upload";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sessionFor(totalBytes: number): OpenedVideoUpload {
  return {
    sessionToken: "session-token",
    videoId: "video-1",
    uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
    headers: { LibraryId: "lib-1", VideoId: "video-1" },
    totalBytes,
    mimeType: "video/mp4",
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

function fileOf(bytes: number, name = "scene.mp4"): File {
  return new File([new Uint8Array(bytes)], name, { type: "video/mp4" });
}

/**
 * A file whose bytes the device cannot produce — a cloud-only file, a card that
 * has been removed, a picker grant that expired.
 *
 * Chrome gives a script no way to tell this apart from a reset socket: both
 * reject the exchange with a bare `TypeError: Failed to fetch`, which is why the
 * transport now reads the slice itself and this shape has to be testable.
 */
function unreadableFileOf(bytes: number, readable = 0): File {
  const real = fileOf(bytes);
  return {
    name: real.name,
    size: real.size,
    type: real.type,
    // `readable` shorter than the slice is the other half of the same fault: a
    // provider that answers in part. 0 means it answers not at all.
    slice: (start: number, end: number) => ({
      arrayBuffer: () =>
        readable === 0
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(new Uint8Array(Math.min(readable, end - start)).buffer),
    }),
  } as unknown as File;
}

/** A 204 with the one header TUS is read through. */
function acknowledged(offset: number): Response {
  return new Response(null, { status: 204, headers: { "upload-offset": String(offset) } });
}

/**
 * Let an upload finish while every retry delay is skipped.
 *
 * The delays are the one thing that must NOT be short in production, so they are
 * advanced rather than shortened: a five-attempt ladder is 7.5 real seconds,
 * which is exactly the budget a test cannot afford to spend.
 */
async function settle(promise: Promise<void>): Promise<void> {
  let done = false;
  const tracked = promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  for (let flush = 0; flush < 20 && !done; flush += 1) {
    await vi.advanceTimersByTimeAsync(2_000);
  }
  await tracked;
  await promise;
}

const patches = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PATCH");

/** The error a call rejected with, for a step that does not sleep. */
async function rejection<T>(promise: Promise<T>): Promise<VideoUploadError> {
  try {
    await promise;
  } catch (error) {
    return error as VideoUploadError;
  }
  throw new Error("expected the call to fail");
}

describe("openVideoUpload", () => {
  it("opens the upload itself and resolves Bunny's relative Location", async () => {
    // Bunny serves a TUS resource only to the network that opened it, so the
    // browser has to be the one that opens it. `Location` comes back relative.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(null, { status: 201, headers: { location: "tusupload/abc123" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const opened = await openVideoUpload(sessionFor(100));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VIDEO_UPLOAD_TUS_ENDPOINT);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Upload-Length"]).toBe("100");
    expect(headers["Tus-Resumable"]).toBe("1.0.0");
    expect(headers["Upload-Metadata"]).toContain("filetype ");
    // The presigned credentials travel with it; the library key never does.
    expect(headers.LibraryId).toBe("lib-1");
    expect(opened.uploadUrl).toBe("https://video.bunnycdn.com/tusupload/abc123");
    expect(opened.sessionToken).toBe("session-token");
  });

  it("refuses a Location that is not Bunny", async () => {
    // This field decides where a creator's video goes, and it is read back out
    // of a response, so it is checked before a single byte is sent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 201, headers: { location: "https://evil.example.com/tusupload/abc" } }))
    );

    const error = await rejection(openVideoUpload(sessionFor(100)));

    expect(error).toMatchObject({ code: "HTTP", stage: "reserve" });
    expect(error.message).toMatch(/somewhere unexpected/i);
  });

  it("names a refusal instead of pretending the upload started", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));

    const error = await rejection(openVideoUpload(sessionFor(100)));

    expect(error).toMatchObject({ code: "HTTP", status: 404, reason: "provider", stage: "reserve" });
    expect(error.providerBody).toBe("Not Found");
  });
});

describe("uploadVideoFile", () => {
  it("resumes from the offset Bunny already holds, not from zero", async () => {
    // 60 of 100 bytes are already in the library. The first request must be a
    // PATCH of the remaining 40 starting at 60 — a restart from zero is the
    // whole-file re-send this transport exists to make unnecessary.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 204, headers: { "upload-offset": "60" } }) : acknowledged(100)
    );
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    await settle(
      uploadVideoFile(fileOf(100), sessionFor(100), {
        onProgress: (value) => progress.push(value.percent),
      })
    );

    const sent = patches(fetchMock);
    expect(sent).toHaveLength(1);
    expect((sent[0][1].headers as Record<string, string>)["Upload-Offset"]).toBe("60");
    // The body is an ArrayBuffer this module read off the file, not the Blob
    // itself: the bytes are known to exist before the request is made.
    expect((sent[0][1].body as ArrayBuffer).byteLength).toBe(40);
    // The first progress report is Bunny's truth, not an assumed zero: a
    // resumed upload must not tell the creator they are back at the start.
    expect(progress[0]).toBe(60);
    expect(progress.at(-1)).toBe(100);
  });

  it("retries a connection reset and continues from the acknowledged byte", async () => {
    // The first PATCH never reaches Bunny. The retry must not restart: it asks
    // where the upload is and continues from there.
    let attempt = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 204, headers: { "upload-offset": "0" } });
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return acknowledged(100);
    });
    vi.stubGlobal("fetch", fetchMock);

    await settle(uploadVideoFile(fileOf(100), sessionFor(100)));

    const sent = patches(fetchMock);
    expect(sent).toHaveLength(2);
    expect((sent[1][1].headers as Record<string, string>)["Upload-Offset"]).toBe("0");
  });

  it("follows Bunny's own offset when it is behind what was sent", async () => {
    // A half-delivered PATCH: Bunny took 30 of the 100 bytes. Believing our own
    // arithmetic here would start the next chunk at 100 and leave a 70-byte hole.
    let patch = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 204, headers: { "upload-offset": "0" } });
      patch += 1;
      return acknowledged(patch === 1 ? 30 : 100);
    });
    vi.stubGlobal("fetch", fetchMock);

    await settle(uploadVideoFile(fileOf(100), sessionFor(100)));

    const sent = patches(fetchMock);
    expect(sent).toHaveLength(2);
    expect((sent[1][1].headers as Record<string, string>)["Upload-Offset"]).toBe("30");
    expect((sent[1][1].body as ArrayBuffer).byteLength).toBe(70);
  });

  it("recovers a 409 by asking Bunny where the upload actually is", async () => {
    // 409 means our offset and Bunny's disagree — the file is fine, our belief
    // is stale. It is not a failure, and it must not consume the retry budget.
    let patch = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 204, headers: { "upload-offset": patch === 0 ? "0" : "100" } });
      }
      patch += 1;
      return patch === 1 ? new Response(null, { status: 409 }) : acknowledged(100);
    });
    vi.stubGlobal("fetch", fetchMock);

    await settle(uploadVideoFile(fileOf(100), sessionFor(100)));

    expect(patch).toBe(1);
  });

  it("continues from the offset a 409 names, even when the confirming HEAD is gone", async () => {
    // The live failure this reproduces: Bunny answers 409 and says exactly where
    // the upload is, and then the confirmation HEAD comes back 404 — which is
    // indistinguishable from a missing signature and used to end the upload as
    // "the video service has closed this upload". Bunny had already said where
    // the file was, so the upload continues from there.
    let patch = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "GET") return new Response(null, { status: 404 });
      patch += 1;
      if (patch === 1) {
        return new Response("Offset does not match file. File offset: 60. Request offset: 0", {
          status: 409,
        });
      }
      return acknowledged(100);
    });
    vi.stubGlobal("fetch", fetchMock);

    await settle(uploadVideoFile(fileOf(100), sessionFor(100), { offset: 0 }));

    const sent = patches(fetchMock);
    expect(sent).toHaveLength(2);
    expect((sent[1][1].headers as Record<string, string>)["Upload-Offset"]).toBe("60");
    expect((sent[1][1].body as ArrayBuffer).byteLength).toBe(40);
  });

  it("names a file the device cannot read instead of blaming the connection", async () => {
    // The live signature this reproduces: five PATCH attempts of 214, 455, 234,
    // 230 and 248 ms, `bytesSent: 0`, all `TypeError: Failed to fetch`. A reset
    // socket is what that reads as, and on a 192 MB file it was the file.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejection(
      uploadVideoFile(unreadableFileOf(100), sessionFor(100), { offset: 0 })
    );

    expect(error.code).toBe("INVALID_FILE");
    expect(error.reason).toBe("unreadable");
    expect(error.stage).toBe("chunk");
    expect(error.message).toMatch(/could not read the video file/);
    // WHERE it died, so a row can tell "the device never opened the file" apart
    // from "it stopped being readable partway through".
    expect(error.offset).toBe(0);
    expect(error.bytesSent).toBe(0);
    expect(error.chunkIndex).toBe(1);
    // And the browser's own words, kept rather than swallowed: this is the one
    // field that says WHICH fault it was, since the sentence above cannot.
    expect(error.providerBody).toBe("TypeError: Failed to fetch");
    // Nothing was offered to the network: this is a fact about the file, and no
    // rung of the retry ladder can change it.
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("says which slice a read died on when the file stops being readable", async () => {
    // A provider that answers in part: the first slice arrives, the bytes go up,
    // and the next read refuses. That is a different fault from a file the
    // device never opened, and the record has to be able to tell them apart.
    const file = fileOf(2_000_000);
    const tracked = {
      name: file.name,
      size: file.size,
      type: file.type,
      slice: (start: number, end: number) =>
        start >= 1_152_000
          ? {
              arrayBuffer: () =>
                Promise.reject(new DOMException("could not be read", "NotReadableError")),
            }
          : file.slice(start, end),
    } as unknown as File;

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => acknowledged(1_152_000));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejection(uploadVideoFile(tracked, sessionFor(2_000_000), { offset: 0 }));

    expect(error).toMatchObject({
      code: "INVALID_FILE",
      reason: "unreadable",
      offset: 1_152_000,
      bytesSent: 1_152_000,
      chunkIndex: 2,
    });
    expect(error.providerBody).toBe("NotReadableError: could not be read");
    // The first slice was sent and acknowledged, so only one PATCH exists.
    expect(patches(fetchMock)).toHaveLength(1);
  });

  it("gives up on a slice that never arrives instead of hanging the upload", async () => {
    // Reading off the phone is instant, so a read is also the one place a cloud
    // file can stall forever with nothing on screen — no request to time out, no
    // error from Chrome, just a progress bar that never moves. The read is raced
    // against a deadline for exactly this shape.
    const file = {
      name: "cloud.mp4",
      size: 100,
      type: "video/mp4",
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }),
    } as unknown as File;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The handler is attached before the clock moves, so the rejection this test
    // is about cannot be reported as an unhandled one.
    const upload = rejection(uploadVideoFile(file, sessionFor(100), { offset: 0 }));
    await vi.advanceTimersByTimeAsync(VIDEO_UPLOAD_READ_TIMEOUT_MS + 1_000);

    const error = await upload;
    expect(error.code).toBe("INVALID_FILE");
    expect(error.reason).toBe("unreadable");
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("refuses a short read rather than sending a body shorter than its slice", async () => {
    // The PATCH promises Upload-Offset and Bunny advances by what arrived, so a
    // body that quietly came back short would leave a hole no later request can
    // fill — an upload that reaches 100% into a video that will not play.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejection(
      uploadVideoFile(unreadableFileOf(100, 10), sessionFor(100), { offset: 0 })
    );

    expect(error.code).toBe("INVALID_FILE");
    expect(error.reason).toBe("unreadable");
    expect(error.providerBody).toMatch(/short read: 10 of 100 bytes/);
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("re-reads the file when a recovery moves the slice, keeping the bytes in step", async () => {
    // The slice is read once per slice, so a retry that starts from a NEW offset
    // must not reuse the previous read: that would send bytes Bunny already has
    // and leave the upload one slice short at the end.
    const seen: number[] = [];
    const file = fileOf(100);
    const tracked = {
      name: file.name,
      size: file.size,
      type: file.type,
      slice: (start: number, end: number) => {
        seen.push(start);
        return file.slice(start, end);
      },
    } as unknown as File;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new TypeError("Failed to fetch");
      return new Response(null, { status: 200, headers: { "upload-offset": "60" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await settleFailure(uploadVideoFile(tracked, sessionFor(100), { offset: 0 }));

    expect(error.code).toBe("NETWORK");
    // Read at 0, then read AGAIN when the recovery moved the position to 60 —
    // and not once more after that, because the last three attempts are retries
    // of the same slice and the bytes cannot have changed.
    expect(seen).toEqual([0, 60]);
    // The record says where the transfer actually got to, not where it began.
    expect(error.offset).toBe(60);
  });

  it("does not retry a refusal Bunny answered", async () => {
    // A 400 is an answer. Five attempts at a request the host has already
    // rejected spends a creator's data to learn the same thing again.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 204, headers: { "upload-offset": "0" } }) : new Response("bad", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(settleFailure(uploadVideoFile(fileOf(100), sessionFor(100)))).resolves.toMatchObject({
      code: "HTTP",
      status: 400,
    });
    expect(patches(fetchMock)).toHaveLength(1);
  });

  it("gives up after its bounded number of attempts", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 204, headers: { "upload-offset": "0" } });
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(settleFailure(uploadVideoFile(fileOf(100), sessionFor(100)))).resolves.toMatchObject({
      code: "NETWORK",
    });
    expect(patches(fetchMock)).toHaveLength(VIDEO_UPLOAD_MAX_ATTEMPTS);
  });

  it("sends the first chunk straight to a session the server just created", async () => {
    // The offset of a brand-new TUS resource is zero by construction, so asking
    // Bunny for it is a round trip a slow connection can lose before a single
    // byte has been sent — and a lost one used to read as "the upload session is
    // no longer available".
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "upload-offset": "0" } }) : acknowledged(100)
    );
    vi.stubGlobal("fetch", fetchMock);

    await settle(uploadVideoFile(fileOf(100), sessionFor(100), { offset: 0 }));

    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "HEAD")).toHaveLength(0);
    const sent = patches(fetchMock);
    expect(sent).toHaveLength(1);
    expect((sent[0][1].headers as Record<string, string>)["Upload-Offset"]).toBe("0");
  });

  it("stops a transfer whose session has expired", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 401 }) : acknowledged(100)
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(settleFailure(uploadVideoFile(fileOf(100), sessionFor(100)))).resolves.toMatchObject({
      code: "EXPIRED",
    });
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("reports a session the service has closed, instead of retrying it", async () => {
    // Bunny answers 404 for an upload it no longer holds (and for a request that
    // arrived without its headers). Neither is retryable, and both must reach
    // the caller as an EXPIRED session — that code is what tells the page to
    // open a fresh one instead of resuming this dead one forever.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 404 }) : acknowledged(100)
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await settleFailure(uploadVideoFile(fileOf(100), sessionFor(100)));

    expect(error).toMatchObject({ code: "EXPIRED", status: 404 });
    expect(error.message).toMatch(/404/);
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it("refuses a file that does not match the session it was built for", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(settleFailure(uploadVideoFile(fileOf(200), sessionFor(100)))).resolves.toMatchObject({
      code: "INVALID_FILE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a file above the 2 GB ceiling before any request", async () => {
    // Described rather than allocated: a real 2 GB File here would be the test
    // suite's own memory bug, and the guard runs before the bytes are ever read.
    const oversized = { size: MAX_VIDEO_BYTES + 1 } as unknown as File;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      settleFailure(uploadVideoFile(oversized, sessionFor(MAX_VIDEO_BYTES + 1)))
    ).resolves.toMatchObject({ code: "INVALID_FILE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** 400 kbps down, the figure measured on a real creator's phone. */
const SLOW_BPS = 50 * 1024;

const ONE_MIB = 1024 * 1024;

/**
 * How long one slice takes to send, in milliseconds, at a rate in bytes/second.
 * The unit the whole adaptation is about.
 */
function durationMs(bytes: number, bps: number): number {
  return (bytes / bps) * 1000;
}

// =============================================================================
// The sizing rule — the fix for "the upload connection was interrupted"
//
// This transport used to send a fixed 16 MiB slice under a fixed 120-second
// timeout. On the 0.4 Mbps connection this application has measured on a real
// creator's phone those two constants do not fit: 16 MiB takes 335 seconds to
// send, so the page aborted its own request, called it a network failure, and
// failed the same way five times. The tests below pin the rule that replaced
// them — a slice sized to the connection and a timeout sized to the slice —
// because it is the difference between an upload that finishes in an hour and
// one that never moves.
// =============================================================================
describe("assertFileReadable", () => {
  it("passes a file the device can hand over", async () => {
    await expect(assertFileReadable(fileOf(200_000))).resolves.toBeUndefined();
  });

  it("names the file, not the connection, when the bytes cannot be produced", async () => {
    // This is the pre-flight version of the same fault the transport now names:
    // it runs the moment a file is picked, so the creator hears it while they
    // are still looking at the picker rather than after a slot was reserved.
    await expect(rejection(assertFileReadable(unreadableFileOf(100)))).resolves.toMatchObject({
      code: "INVALID_FILE",
      reason: "unreadable",
      stage: "chunk",
    });
  });

  it("reads a probe and not the file, so a 2 GB video costs nothing to check", async () => {
    const sizes: number[] = [];
    const file = fileOf(1_500_000);
    const tracked = {
      name: file.name,
      size: file.size,
      type: file.type,
      slice: (start: number, end: number) => {
        sizes.push(end - start);
        return file.slice(start, end);
      },
    } as unknown as File;

    await assertFileReadable(tracked);

    expect(sizes).toEqual([VIDEO_UPLOAD_READ_PROBE_BYTES]);
  });
});

describe("chunk planning", () => {
  it("starts with a slice small enough to be cheap to abandon", () => {
    // The first request is the only one made blind. Sizing it for a fast link
    // would hand a slow one a six-minute request before a byte is measured.
    const first = chunkBytesFor(null, 145 * ONE_MIB);

    expect(first).toBeLessThanOrEqual(2 * ONE_MIB);
    expect(first).toBeGreaterThan(0);
    // Built from the documented floor rather than from luck.
    expect(first).toBe(Math.ceil((VIDEO_UPLOAD_FLOOR_BPS * VIDEO_UPLOAD_TARGET_CHUNK_MS) / 1000));
  });

  it("sizes the slice to the measured connection, not to a constant", () => {
    const slow = chunkBytesFor(SLOW_BPS, 145 * ONE_MIB);
    const fast = chunkBytesFor(5 * ONE_MIB, 145 * ONE_MIB);

    // The whole point: a slow link gets many short requests, a fast one gets
    // few long ones, and neither gets the other's size.
    expect(fast).toBeGreaterThan(slow * 4);
    expect(fast).toBe(VIDEO_UPLOAD_MAX_CHUNK_BYTES);
  });

  it("never sends more than is left, and never more than the ceiling", () => {
    expect(chunkBytesFor(null, 40)).toBe(40);
    expect(chunkBytesFor(10 * ONE_MIB, 40)).toBe(40);
    expect(chunkBytesFor(10 * ONE_MIB, 2 * MAX_VIDEO_BYTES)).toBe(VIDEO_UPLOAD_MAX_CHUNK_BYTES);
  });

  it("gives every request headroom over the time its own slice needs", () => {
    // The invariant that was missing. For any connection at or above the
    // planned floor, the timeout for the slice chosen must exceed the time that
    // slice takes — otherwise the page aborts a request that was working.
    for (const bps of [VIDEO_UPLOAD_FLOOR_BPS, SLOW_BPS, 1 * ONE_MIB, 5 * ONE_MIB]) {
      const bytes = chunkBytesFor(bps, 145 * ONE_MIB);
      expect(chunkTimeoutMs(bytes, bps)).toBeGreaterThan(durationMs(bytes, bps));
    }
  });

  it("keeps a slow link's requests short instead of relying on a long timeout", () => {
    // At the measured 0.4 Mbps the slice must come out well under a minute of
    // transfer. A six-minute request is what a carrier resets, and no timeout
    // makes it survivable — only a smaller request does.
    const bytes = chunkBytesFor(SLOW_BPS, 145 * ONE_MIB);
    expect(durationMs(bytes, SLOW_BPS)).toBeLessThanOrEqual(VIDEO_UPLOAD_TARGET_CHUNK_MS);
    expect(chunkTimeoutMs(bytes, SLOW_BPS)).toBeLessThanOrEqual(VIDEO_UPLOAD_TARGET_CHUNK_MS * 4);
  });

  it("moves the throughput estimate toward what it just measured", () => {
    // Halving the distance doubles the estimate within two slices — fast enough
    // for a fast connection and stable enough not to thrash on a slow one.
    const first = measureRate(2 * ONE_MIB, 1_000, null);
    expect(first).toBeCloseTo(2 * ONE_MIB, -3);

    const halved = measureRate(ONE_MIB, 1_000, 4 * ONE_MIB);
    expect(halved).toBeGreaterThan(4 * ONE_MIB * 0.6);
    expect(halved).toBeLessThan(4 * ONE_MIB);

    // A measurement that cannot be trusted leaves the estimate alone.
    expect(measureRate(0, 1_000, 123)).toBe(123);
    expect(measureRate(100, 0, 123)).toBe(123);
  });
});

// =============================================================================
// A failed upload must be able to explain itself
//
// The bytes go straight to Bunny, so a failure leaves no row and no log line —
// the browser's own error is the only witness. These fields are what the admin
// panel and the provider log are read from, and a report that carried only "the
// upload connection was interrupted" is the report this application had for
// weeks: true, useless, and identical for four different faults.
// =============================================================================
describe("the diagnosis on a failed upload", () => {
  it("carries the reason, the offset and how long each attempt lasted", async () => {
    let patch = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 204, headers: { "upload-offset": "0" } });
      }
      patch += 1;
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await settleFailure(uploadVideoFile(fileOf(100), sessionFor(100), { offset: 0 }));

    expect(error).toMatchObject({
      code: "NETWORK",
      reason: "reset",
      stage: "chunk",
      chunkIndex: 1,
      offset: 0,
      bytesSent: 0,
      bytesTotal: 100,
    });
    // One timing per attempt, so the shape of the failure survives the toast.
    expect(error.attemptMs).toHaveLength(VIDEO_UPLOAD_MAX_ATTEMPTS);
    // The message names the position, which is the only part a creator can act on.
    expect(error.message).toMatch(/connection dropped/i);
    expect(error.message).toMatch(/Resume upload/);
    expect(patch).toBe(VIDEO_UPLOAD_MAX_ATTEMPTS);
  });

  it("keeps Bunny's own words when Bunny is what refused the chunk", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 204, headers: { "upload-offset": "0" } })
        : new Response("Library ID missing or invalid.", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await settleFailure(uploadVideoFile(fileOf(100), sessionFor(100), { offset: 0 }));

    expect(error).toMatchObject({ code: "HTTP", status: 400, reason: "provider" });
    expect(error.providerBody).toBe("Library ID missing or invalid.");
  });
});

describe("videoFileSizeError", () => {
  it("passes an ordinary file and fails an empty or oversized one", () => {
    expect(videoFileSizeError({ size: 1_500_000 })).toBeNull();
    expect(videoFileSizeError({ size: MAX_VIDEO_BYTES })).toBeNull();
    expect(videoFileSizeError({ size: 0 })).toMatch(/empty/i);
    expect(videoFileSizeError({ size: MAX_VIDEO_BYTES + 1 })).toMatch(/2 GB/);
  });
});

describe("completeVideoUpload", () => {
  it("returns the id only when the server confirmed the whole file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, data: { videoId: "video-1" } }))
    );

    await expect(completeVideoUpload("session-token")).resolves.toBe("video-1");
  });

  it("surfaces an incomplete upload as a conflict, not a success", async () => {
    // The server refuses to declare an upload finished while Bunny's offset is
    // short. Treating that answer as success is how a post is created for a file
    // that is only half there.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, error: "Upload is not complete yet (Bunny has 40 of 100 bytes)" }, { status: 409 })
      )
    );

    await expect(completeVideoUpload("session-token")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });
});

/** Turn a rejected upload into the error it threw, so a test can assert on it. */
async function settleFailure(promise: Promise<void>): Promise<VideoUploadError> {
  try {
    await settle(promise);
  } catch (error) {
    return error as VideoUploadError;
  }
  throw new Error("expected the upload to fail");
}
