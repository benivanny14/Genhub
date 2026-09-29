// =============================================================================
// GENHUB - TUS direct upload
//
// The uploader replaced a single PUT that could never have worked: Bunny's
// management endpoint wants the `AccessKey` header, and a 401 with no body is a
// terrible thing to debug from a creator's phone. The checks below are the ones
// that fail BEFORE any bytes move, plus the metadata encoding, which is the part
// that silently corrupts non-ASCII titles.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  adaptChunkSize,
  encodeUploadMetadata,
  initialChunkSize,
  uploadFileWithTus,
  TusUploadError,
  videoSizeError,
  CHUNK_STALL_TIMEOUT_MS,
  DESKTOP_CHUNK_SIZE,
  FAST_CHUNK_SIZE,
  MAX_VIDEO_BYTES,
  MOBILE_CHUNK_SIZE,
  TUS_CHUNK_ALIGNMENT,
  UPLOAD_STALL_WARNING_MS,
} from "@/lib/tus-upload";

const credentials = {
  endpoint: "https://video.bunnycdn.com/tusupload",
  videoId: "vid-1",
  libraryId: "12345",
  expirationTime: Math.floor(Date.now() / 1000) + 3600,
  signature: "a".repeat(64),
};

const fileOf = (bytes: number, name = "scene.mp4") =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

/** A File whose only real property is its size — 2 GB must not be allocated. */
const bigFileOf = (bytes: number) =>
  ({ size: bytes, type: "video/mp4", name: "scene.mp4" }) as unknown as File;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TUS direct upload", () => {
  it("refuses an expired authorization without sending anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const expired = { ...credentials, expirationTime: Math.floor(Date.now() / 1000) - 1 };

    await expect(uploadFileWithTus(fileOf(1024), expired)).rejects.toMatchObject({
      code: "EXPIRED",
    });
    await expect(uploadFileWithTus(fileOf(1024), expired)).rejects.toBeInstanceOf(
      TusUploadError
    );
    // The point of the check: no request, so no opaque 401 to interpret.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty file instead of reserving a slot for nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(uploadFileWithTus(fileOf(0), credentials)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a file this device will not let the page read, and says device rather than network", async () => {
    // What a phone hands over when the video came from another app's storage: a
    // File whose bytes cannot be read back. Chrome fails that read lazily, so
    // without the probe the uploader sends the whole ladder, gets nothing
    // acknowledged, and reports "the connection dropped" — which is what the
    // live panel showed for a 5.5 MB file on a working 4G link.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // What Chrome raises when the read itself is refused. The name is the whole
    // diagnosis — permission, file gone, or provider refusing — so it is carried
    // out of the probe rather than swallowed by it.
    const refused = Object.assign(new Error("The requested file could not be read."), {
      name: "NotReadableError",
    });
    const unreadable = {
      name: "1000371423.mp4",
      size: 5_804_475,
      type: "video/mp4",
      slice: () => ({ arrayBuffer: () => Promise.reject(refused) }),
    } as unknown as File;

    const error = (await uploadFileWithTus(unreadable, credentials).catch(
      (caught: unknown) => caught
    )) as { code: string; reason: string; message: string; providerBody: string };

    expect(error).toMatchObject({ code: "UNSUPPORTED", reason: "preflight" });
    // Named for the creator, and quoted for whoever reads the record afterwards.
    expect(error.message).toContain("NotReadableError");
    expect(error.message).toMatch(/photos and videos/);
    expect(error.providerBody).toBe(
      "NotReadableError: The requested file could not be read."
    );
    // Nothing was reserved and nothing was retried: the fault is the device and
    // no amount of patience or smaller chunks would have changed it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads one kilobyte to prove the file is reachable, not the whole file", async () => {
    // The probe runs before EVERY upload, the successful ones included, so it
    // has to be cheap. One slice, of 1 KB, before the reserve.
    const slices: Array<{ start: number; end: number }> = [];
    const real = fileOf(1024 * 1024);
    const probed = {
      name: real.name,
      size: real.size,
      type: real.type,
      slice: (start: number, end: number) => {
        slices.push({ start, end });
        return real.slice(start, end);
      },
    } as unknown as File;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 201 }))
    );

    // Fails on the missing Location, which is after the probe and before any
    // PATCH — so the slices recorded are the probe's and nothing else.
    await expect(uploadFileWithTus(probed, credentials)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    expect(slices).toEqual([{ start: 0, end: 1024 }]);
  });

  it("refuses a file over 2 GB before any bytes are sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      uploadFileWithTus(bigFileOf(MAX_VIDEO_BYTES + 1), credentials)
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the authorization headers TUS requires on the reserve call", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        // No Location => the uploader must fail loudly rather than guess.
        return new Response("", { status: 201 });
      })
    );

    await expect(
      uploadFileWithTus(fileOf(1024), credentials)
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://video.bunnycdn.com/tusupload");
    expect(calls[0].headers).toMatchObject({
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "1024",
      AuthorizationSignature: credentials.signature,
      AuthorizationExpire: String(credentials.expirationTime),
      LibraryId: "12345",
      VideoId: "vid-1",
    });
  });

  it("re-sends the authorization headers on every PATCH", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        // Relative Location, exactly like Bunny answers.
        new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );

    const patches: Array<Record<string, string>> = [];
    class FakeXhr {
      upload = { onprogress: null as unknown };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "Upload-Offset" ? "1024" : null;
      }
      abort() {}
      send() {
        patches.push({ ...this.headers });
        this.status = 204;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);

    await uploadFileWithTus(fileOf(1024), credentials);

    expect(patches).toHaveLength(1);
    // Omitting these makes Bunny answer `400 Library ID missing or invalid.`
    expect(patches[0]).toMatchObject({
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      AuthorizationSignature: credentials.signature,
      AuthorizationExpire: String(credentials.expirationTime),
      LibraryId: "12345",
      VideoId: "vid-1",
    });
  });

  it("base64-encodes metadata values so non-ASCII titles survive", () => {
    const metadata = encodeUploadMetadata({
      filetype: "video/mp4",
      title: "Ngoma ya usiku — sehemu 2",
    });

    // Keys stay plain text; values are base64.
    expect(metadata.startsWith("filetype dmlkZW8vbXA0,title ")).toBe(true);

    const encodedTitle = metadata.split("title ")[1];
    expect(Buffer.from(encodedTitle, "base64").toString("utf8")).toBe(
      "Ngoma ya usiku — sehemu 2"
    );
    // A naive btoa(title) on this string throws; the encoder must not.
    expect(metadata).not.toMatch(/[\s,]=*$/);
  });
});

// =============================================================================
// Chunk sizing — the mobile half of the upload
//
// The old fixed 32 MiB was the single biggest reason an upload from a phone
// ended in a frozen bar: one lost signal anywhere in a 32 MiB chunk threw away
// minutes of transfer, and on a phone that is most of what a 300 MB file is.
// These pin the rules, including that every answer is a legal TUS chunk size.
// =============================================================================

describe("chunk sizing", () => {
  it("starts a phone smaller than a desktop", () => {
    const size = 500 * 1024 * 1024;
    expect(initialChunkSize(true, size)).toBe(MOBILE_CHUNK_SIZE);
    expect(initialChunkSize(false, size)).toBe(DESKTOP_CHUNK_SIZE);
    expect(MOBILE_CHUNK_SIZE).toBeLessThan(DESKTOP_CHUNK_SIZE);
  });

  it("never asks for a chunk larger than the file", () => {
    // A 1 MB file on a phone is one request, not two.
    expect(initialChunkSize(true, 1024 * 1024)).toBe(1024 * 1024);
  });

  it("always returns a multiple of 256 KiB, which the TUS spec requires", () => {
    for (const isMobile of [true, false]) {
      expect(initialChunkSize(isMobile, 500 * 1024 * 1024) % TUS_CHUNK_ALIGNMENT).toBe(0);
    }
    for (const rate of [1, 100_000, 500_000, 5_000_000, 50_000_000]) {
      expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, rate) % TUS_CHUNK_ALIGNMENT).toBe(0);
    }
  });

  it("shrinks to the phone size on a genuinely slow connection", () => {
    // 250 KB/s: a 32 MiB chunk would be two minutes of work at risk.
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 250 * 1024)).toBe(MOBILE_CHUNK_SIZE);
  });

  it("grows back once the connection proves itself", () => {
    expect(adaptChunkSize(MOBILE_CHUNK_SIZE, 5 * 1024 * 1024)).toBe(FAST_CHUNK_SIZE);
  });

  it("leaves a middling connection alone instead of oscillating", () => {
    // Halfway between the two thresholds is where a size that is working is not
    // worth re-deciding every single chunk.
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 1024 * 1024)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(MOBILE_CHUNK_SIZE, 1024 * 1024)).toBe(MOBILE_CHUNK_SIZE);
  });

  it("ignores a nonsense measurement rather than resizing on it", () => {
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 0)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, Number.NaN)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, -5)).toBe(DESKTOP_CHUNK_SIZE);
  });

  it("warns a creator before the transport gives up on a dead connection", () => {
    // The warning has to fire while the creator is still looking at the screen:
    // the whole point is that they can still do something about it.
    expect(UPLOAD_STALL_WARNING_MS).toBeGreaterThan(10_000);
    expect(UPLOAD_STALL_WARNING_MS).toBeLessThan(3 * 60 * 1000);
  });

  it("pins the chunk size when a caller supplies one", async () => {
    // Tests and any future caller that knows better must not have their size
    // rewritten mid-upload.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );

    const seen: number[] = [];
    class FakeXhr {
      upload = { onprogress: null as unknown };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "Upload-Offset" ? this.nextOffset : null;
      }
      abort() {}
      nextOffset = "0";
      send(blob: Blob) {
        seen.push(blob.size);
        this.nextOffset = String(Number(this.headers["Upload-Offset"]) + blob.size);
        this.status = 204;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);

    await uploadFileWithTus(fileOf(TUS_CHUNK_ALIGNMENT * 3), credentials, {
      chunkSize: TUS_CHUNK_ALIGNMENT,
    });

    expect(seen).toEqual([
      TUS_CHUNK_ALIGNMENT,
      TUS_CHUNK_ALIGNMENT,
      TUS_CHUNK_ALIGNMENT,
    ]);
  });
});

describe("video size guard", () => {
  it("accepts a file right at the 2 GB limit", () => {
    expect(videoSizeError(bigFileOf(MAX_VIDEO_BYTES))).toBeNull();
  });

  it("names the size and the limit so the creator knows what to do", () => {
    const message = videoSizeError(bigFileOf(3 * 1024 * 1024 * 1024));
    expect(message).toMatch(/3\.00 GB/);
    expect(message).toMatch(/2 GB/);
  });
});

// =============================================================================
// What a failed upload says about itself
//
// Every report that reached the admin panel read as the same single word —
// NETWORK — with no HTTP status and no Bunny response body, so nothing in the
// record said WHICH request died, or whether a byte had ever left the browser.
// Four identical lines cannot be diagnosed. These pin the two facts that can.
// =============================================================================

describe("what a failed upload reports about itself", () => {
  const FOUR_MIB = 4 * 1024 * 1024;

  /**
   * A PATCH that dies the way the creator's did: no response at all.
   *
   * `sentBytes` is what the browser had handed to the socket when it gave up,
   * which is the whole distinction the report now carries. The handlers are set
   * before `send()` in sendChunk, so failing synchronously here is the same
   * order a real socket failure arrives in.
   */
  function XhrThatDrops(sentBytes: number) {
    return class {
      upload = {
        onprogress: undefined as
          | ((event: { lengthComputable: boolean; loaded: number }) => void)
          | undefined,
      };
      status = 0;
      responseText = "";
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        // Nothing answered, so there is no offset to read — which also stops the
        // retry from deciding the server already holds this chunk.
        return null;
      }
      abort() {}
      send() {
        if (sentBytes > 0) {
          this.upload.onprogress?.({ lengthComputable: true, loaded: sentBytes });
        }
        this.onerror?.();
      }
    };
  }

  /** Reserve answers normally, so only the chunk transfer can fail. */
  function stubReserve() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );
  }

  /**
   * Run one doomed upload to completion.
   *
   * The retry ladder is bounded and includes the silence watchdog, so the clock
   * is moved rather than waited on — the point of the test is the error that
   * comes out the other end, not how long the browser politely waits.
   */
  async function runToFailure(): Promise<TusUploadError> {
    vi.useFakeTimers();
    try {
      const attempt = uploadFileWithTus(fileOf(FOUR_MIB), credentials, {
        chunkSize: TUS_CHUNK_ALIGNMENT,
      });
      // Handled the moment it exists: the rejection lands while the clock below
      // is being advanced, and a bare promise would be reported unhandled long
      // before the assertion ever sees it.
      const settled = attempt.then(
        () => {
          throw new Error("this upload was supposed to fail");
        },
        (error: TusUploadError) => error
      );
      // The whole ladder: one silence window per attempt, plus the backoff
      // between them. Comfortably more than it needs, so a longer ladder does
      // not turn this into a flaky race.
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      return await settled;
    } finally {
      vi.useRealTimers();
    }
  }

  it("names the request that died, not just the code", async () => {
    // Without `stage` the panel prints "NETWORK" and nothing else — the same
    // words a failed RESERVE produces, and a completely different fault.
    stubReserve();
    vi.stubGlobal("XMLHttpRequest", XhrThatDrops(0) as unknown as typeof XMLHttpRequest);

    await expect(runToFailure()).resolves.toMatchObject({
      code: "NETWORK",
      stage: "chunk",
    });
  });

  it("counts the bytes that had left the browser when the connection dropped", async () => {
    stubReserve();
    const SENT = 128 * 1024;
    vi.stubGlobal("XMLHttpRequest", XhrThatDrops(SENT) as unknown as typeof XMLHttpRequest);

    await expect(runToFailure()).resolves.toMatchObject({
      stage: "chunk",
      bytesSent: SENT,
      bytesTotal: FOUR_MIB,
    });
  });

  it("records nothing sent when the request never reached the wire", async () => {
    // Zero with no HTTP status is the signature of a request that was never
    // sent — blocked, offline, or refused before it left. It is not the same
    // finding as a transfer that was moving, and the byte count is what says so.
    stubReserve();
    vi.stubGlobal("XMLHttpRequest", XhrThatDrops(0) as unknown as typeof XMLHttpRequest);

    await expect(runToFailure()).resolves.toMatchObject({
      bytesSent: 0,
      bytesTotal: FOUR_MIB,
    });
  });

  it("blames the reserve call when the slot was never created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    await expect(uploadFileWithTus(fileOf(FOUR_MIB), credentials)).rejects.toMatchObject({
      code: "NETWORK",
      stage: "reserve",
      bytesSent: 0,
      bytesTotal: FOUR_MIB,
    });
  });

  it("still carries the file size when the refusal precedes any request", async () => {
    // A report with a size and no bytes reads as "none of it moved"; a report
    // with neither reads as nothing at all.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      uploadFileWithTus(bigFileOf(MAX_VIDEO_BYTES + 1), credentials)
    ).rejects.toMatchObject({ bytesSent: 0, bytesTotal: MAX_VIDEO_BYTES + 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// The stall watchdog — silence, not slowness
//
// The window has to mean "no bytes moved for this long", not "this request must
// finish in this long". Those were the same thing in the code for as long as the
// value was assigned to `xhr.timeout`, and the difference is an upload that
// cannot succeed however long the creator waits: a 16 MiB chunk on a 100 KB/s
// phone needs nearly three minutes of healthy transfer, so every attempt failed,
// every retry started the same chunk from the same offset, and the ladder was
// spent in six tries. Measured on a real link a 4 MiB chunk took 5.7s, so the
// margin is not theoretical.
//
// One test for each half of the promise: a chunk that keeps moving may take as
// long as it likes, and a chunk that goes quiet is still abandoned.
// =============================================================================

describe("the stall watchdog", () => {
  const CHUNK = TUS_CHUNK_ALIGNMENT;

  function stubReserve() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );
  }

  /**
   * A fake XHR that reports progress on a clock, because progress is the only
   * thing the watchdog listens to.
   *
   * `events` and `perEventMs` set how long the chunk takes, and the total is
   * deliberately LONGER than the stall window — the case the old total-time cap
   * got wrong. `timeout` is a real accessor that does what a browser does with
   * it, so "the cap is no longer set" is an assertion rather than a comment.
   */
  function clockedXhr(events: number, perEventMs: number) {
    return class {
      upload = {
        onprogress: undefined as
          | ((event: { lengthComputable: boolean; loaded: number }) => void)
          | undefined,
      };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      private nextOffset = "0";
      private cap = 0;
      get timeout() {
        return this.cap;
      }
      set timeout(ms: number) {
        this.cap = ms;
        setTimeout(() => this.ontimeout?.(), ms);
      }
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "Upload-Offset" ? this.nextOffset : null;
      }
      abort() {
        this.onabort?.();
      }
      send(blob: Blob) {
        const step = Math.ceil(blob.size / events);
        let loaded = 0;
        const tick = () => {
          loaded = Math.min(loaded + step, blob.size);
          this.upload.onprogress?.({ lengthComputable: true, loaded });
          if (loaded < blob.size) {
            setTimeout(tick, perEventMs);
            return;
          }
          this.nextOffset = String(Number(this.headers["Upload-Offset"]) + blob.size);
          this.status = 204;
          this.onload?.();
        };
        setTimeout(tick, perEventMs);
      }
    };
  }

  it("lets a chunk outlast the stall window while bytes keep moving", async () => {
    stubReserve();
    // Four moves, one a minute: the chunk takes four minutes, which is past the
    // stall window on every count except the one that matters — no single gap is.
    vi.stubGlobal(
      "XMLHttpRequest",
      clockedXhr(4, 60_000) as unknown as typeof XMLHttpRequest
    );

    vi.useFakeTimers();
    try {
      const upload = uploadFileWithTus(fileOf(CHUNK), credentials, { chunkSize: CHUNK });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(upload).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still abandons a chunk that goes completely quiet", async () => {
    stubReserve();
    class SilentXhr {
      upload = { onprogress: undefined as unknown };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return null;
      }
      abort() {
        this.onabort?.();
      }
      send() {}
    }
    vi.stubGlobal("XMLHttpRequest", SilentXhr as unknown as typeof XMLHttpRequest);

    vi.useFakeTimers();
    try {
      const attempt = uploadFileWithTus(fileOf(CHUNK), credentials, { chunkSize: CHUNK });
      const settled = attempt.then(
        () => {
          throw new Error("this upload was supposed to fail");
        },
        (error: TusUploadError) => error
      );
      // One silence window per attempt, plus the backoff between them.
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await expect(settled).resolves.toMatchObject({
        code: "NETWORK",
        stage: "chunk",
        message: "The upload stalled and was retried.",
        bytesSent: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the window long enough that a slow phone is not one long stall", () => {
    expect(CHUNK_STALL_TIMEOUT_MS).toBeGreaterThan(UPLOAD_STALL_WARNING_MS);
  });
});
