// =============================================================================
// GENHUB - Retrying, resuming and cancelling a chunk
//
// The production failure this suite grew out of had one shape: a PATCH to Bunny
// died mid-chunk, and the only thing that could be said about it afterwards was
// "NETWORK". Everything below is the set of facts that has to be true for a
// dropped connection to be recoverable rather than fatal.
//
//   1. A dropped chunk is RETRIED, and the retry goes from the byte the server
//      actually holds — not from the start of the chunk. Resending a chunk the
//      server half-holds is how the same bytes get written twice and how the
//      offset silently drifts.
//   2. Only transient faults consume a retry. A 401 (expired signature) or a
//      413 (too large) will never improve by sending the same bytes again, and
//      burning the ladder on them just delays the message the creator needs.
//   3. Progress is CUMULATIVE for the whole file. A retry that re-sends a chunk
//      must not walk the bar backwards — from the creator's side that reads as
//      the upload having started over, which is what they then give up on.
//   4. A cancel is a cancel. It stops the transfer, it is not retried, and it
//      is reported as the creator's own action rather than as a fault.
//   5. Every failure says where it happened: which chunk, from which offset,
//      after how many retries, and which physical fault it was.
//
// The clock is faked throughout — the real ladder is seconds of deliberate
// waiting, and a test that waits for it is a test nobody runs.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadFileWithTus,
  describeRetry,
  TusUploadError,
  CHUNK_RETRY_DELAYS,
  TUS_CHUNK_ALIGNMENT,
  type TusUploadRetryInfo,
} from "@/lib/tus-upload";

const credentials = {
  endpoint: "https://video.bunnycdn.com/tusupload",
  videoId: "vid-1",
  libraryId: "12345",
  expirationTime: Math.floor(Date.now() / 1000) + 3600,
  signature: "a".repeat(64),
};

const CHUNK = TUS_CHUNK_ALIGNMENT;

const fileOf = (bytes: number, name = "scene.mp4") =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** What one PATCH attempt should do. */
interface Attempt {
  /** The connection dies with no answer, after `sentBytes` of progress. */
  drop?: boolean;
  /** The server answers with this status (and body). */
  status?: number;
  body?: string;
  /** Progress reported before anything else happens. */
  sentBytes?: number;
  /**
   * Nothing answers and nothing happens — the signature of a suspended tab.
   * No error event, no timeout, no bytes: only the silence watchdog can catch
   * this one, which is why it is a separate script entry from `drop`.
   */
  silent?: boolean;
  /** The creator presses Cancel during this attempt. */
  abort?: boolean;
}

/**
 * A PATCH that works through a script, one entry per attempt.
 *
 * The last entry repeats once the script runs out, which is what makes "it
 * never succeeds" expressible as a one-line script.
 */
function scriptedXhr(script: Attempt[], onSend?: (offset: number) => void) {
  let attempt = 0;
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

    open() {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    getResponseHeader(name: string) {
      return name === "Upload-Offset" ? this.nextOffset : null;
    }
    abort() {
      // The real object fires this; the uploader listens for it to tell a
      // cancel apart from a stall, so the fake has to as well.
      this.onabort?.();
    }

    send(blob: Blob) {
      const step = script[Math.min(attempt, script.length - 1)];
      attempt += 1;

      const offset = Number(this.headers["Upload-Offset"]);
      onSend?.(offset);

      if (step.sentBytes) {
        this.upload.onprogress?.({ lengthComputable: true, loaded: step.sentBytes });
      }

      if (step.abort) {
        queueMicrotask(() => this.onabort?.());
        return;
      }
      if (step.silent) return;
      if (step.drop) {
        queueMicrotask(() => this.onerror?.());
        return;
      }

      this.status = step.status ?? 204;
      this.responseText = step.body ?? "";
      this.nextOffset = String(offset + blob.size);
      queueMicrotask(() => this.onload?.());
    }
  };
}

/**
 * Reserve answers normally; HEAD answers with `headOffset` (or fails, when it
 * is null). Both are `fetch`, so the method is what tells them apart — which is
 * also how the uploader itself tells them apart.
 */
function stubFetch(options: { headOffset?: number | null } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url: String(url) });

      if (method === "HEAD") {
        const { headOffset } = options;
        if (headOffset === null || headOffset === undefined) {
          return new Response("", { status: 500 });
        }
        return new Response("", {
          status: 200,
          headers: { "Upload-Offset": String(headOffset) },
        });
      }

      return new Response("", { status: 201, headers: { Location: "/tusupload/abc" } });
    })
  );
  return calls;
}

/** Run an upload to completion on a faked clock, and return what it did. */
async function run(
  file: File,
  script: Attempt[],
  options: {
    headOffset?: number | null;
    onRetry?: (info: TusUploadRetryInfo) => void;
    onProgress?: (uploaded: number, total: number) => void;
    signal?: AbortSignal;
    advanceMs?: number;
  } = {}
) {
  const calls = stubFetch({ headOffset: options.headOffset });
  const sends: number[] = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    scriptedXhr(script, (offset) => sends.push(offset)) as unknown as typeof XMLHttpRequest
  );

  vi.useFakeTimers();
  const upload = uploadFileWithTus(file, credentials, {
    chunkSize: CHUNK,
    onRetry: options.onRetry,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  // Every promise is settled the moment it exists, so a rejection lands while
  // the clock below is being advanced instead of being reported as unhandled.
  const settled = upload.then(
    () => null,
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(options.advanceMs ?? 15 * 60_000);
  return { error: (await settled) as TusUploadError | null, sends, calls };
}

describe("retrying a dropped chunk", () => {
  it("sends the chunk again when the connection dies, and finishes", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [{ drop: true }, {}]);

    expect(error).toBeNull();
    // Two PATCHes, both from the same offset: the server acknowledged nothing,
    // so the retry has nothing to skip.
    expect(sends).toEqual([0, 0]);
  });

  it("resumes from the offset the server confirms instead of resending", async () => {
    // The case that makes TUS worth its complexity: the connection died, but
    // Bunny had already stored part of the chunk. Re-asking HEAD is what turns
    // that into bytes that do not have to move again — the second PATCH starts
    // at the byte the server confirms, not at the start of the chunk.
    const half = CHUNK / 2;
    const { error, sends } = await run(
      fileOf(CHUNK),
      [{ drop: true, sentBytes: half }, {}],
      { headOffset: half }
    );

    expect(error).toBeNull();
    // First PATCH from 0 (it died), second from the offset Bunny confirmed —
    // the half that arrived is never sent twice.
    expect(sends).toEqual([0, half]);
  });

  it("resends when HEAD knows nothing, rather than assuming the bytes were lost", async () => {
    // The opposite mistake: treating an unreachable HEAD as \"the server holds
    // the whole chunk\" would skip bytes that never arrived, and the file would
    // be written short with every check green.
    const { error, sends } = await run(fileOf(CHUNK), [{ drop: true }, {}], { headOffset: null });

    expect(error).toBeNull();
    expect(sends).toEqual([0, 0]);
  });

  it("keeps retrying a 429 and a 5xx, which are the transient ones", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [
      { status: 429, body: "slow down" },
      { status: 503, body: "try later" },
      {},
    ]);

    expect(error).toBeNull();
    expect(sends).toHaveLength(3);
  });

  it("keeps retrying a 423 Locked, which is what Bunny says about a session the lost PATCH still holds", async () => {
    // Measured on a real device (Android emulator, network cut in the middle of
    // a 60 MB upload): the first attempt that reaches Bunny after the
    // connection comes back is refused with 423, because the aborted PATCH is
    // still locked on the server. Read as permanent it ends an upload that was
    // a quarter sent, on a connection that was working again.
    const { error, sends } = await run(fileOf(CHUNK), [
      { status: 423, body: "Locked" },
      {},
    ]);

    expect(error).toBeNull();
    expect(sends).toHaveLength(2);
  });

  it("says what it is doing between the attempts", async () => {
    const seen: TusUploadRetryInfo[] = [];
    const { error } = await run(fileOf(CHUNK), [{ drop: true }, {}], {
      onRetry: (info) => seen.push(info),
    });

    expect(error).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      chunkIndex: 0,
      attempt: 1,
      totalAttempts: CHUNK_RETRY_DELAYS.length,
      offset: 0,
      reason: "reset",
    });
  });
});

describe("failures that retrying cannot fix", () => {
  it("does not retry a 401, and says the authorization is the problem", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [
      { status: 401, body: "Unauthorized" },
    ]);

    expect(sends).toHaveLength(1);
    expect(error).toMatchObject({
      code: "REJECTED",
      status: 401,
      stage: "chunk",
      reason: "provider",
      chunkIndex: 0,
      retryCount: 0,
    });
    // Bunny's own words survive into the report; that is what names the cause.
    expect(error?.providerBody).toBe("Unauthorized");
  });

  it("does not retry a 403", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [{ status: 403, body: "nope" }]);

    expect(sends).toHaveLength(1);
    expect(error).toMatchObject({ code: "REJECTED", status: 403 });
  });

  it("does not retry a 413, which is the file and not the connection", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [{ status: 413, body: "too big" }]);

    expect(sends).toHaveLength(1);
    expect(error).toMatchObject({ code: "UNSUPPORTED", status: 413 });
  });

  it("does not retry a body Bunny refused as invalid", async () => {
    const { error, sends } = await run(fileOf(CHUNK), [
      { status: 400, body: "Library ID missing or invalid." },
    ]);

    expect(sends).toHaveLength(1);
    expect(error).toMatchObject({ code: "REJECTED", status: 400 });
    expect(error?.providerBody).toContain("Library ID missing");
  });
});

describe("what a run of retries reports", () => {
  it("counts the retries, the chunk and the server offset when the ladder runs out", async () => {
    const { error, sends } = await run(fileOf(CHUNK * 2), [{ drop: true }], { headOffset: null });

    // The whole ladder spent on the first chunk.
    expect(sends).toHaveLength(CHUNK_RETRY_DELAYS.length);
    expect(error).toMatchObject({
      code: "NETWORK",
      stage: "chunk",
      reason: "reset",
      chunkIndex: 0,
      offset: 0,
      retryCount: CHUNK_RETRY_DELAYS.length - 1,
    });
  });

  it("keeps trying a connection that went away and came back", async () => {
    // The failure this ladder exists for, measured on a real deployment: a phone
    // whose connection drops for tens of seconds loses every attempt of a short
    // ladder and every byte of a 192 MB upload. Attempts four and five are
    // failed here, so the upload only finishes if the tail of the ladder is
    // still trying a minute in.
    const { error, sends } = await run(
      fileOf(CHUNK),
      [{ drop: true }, { drop: true }, { drop: true }, { drop: true }, {}],
      { headOffset: null }
    );

    expect(error).toBeNull();
    expect(sends).toHaveLength(5);
  });

  it("makes progress cumulative across chunks and retries, never backwards", async () => {
    const total = CHUNK * 3;
    const progress: number[] = [];
    // Chunk 0 dies twice, chunk 1 dies once, chunk 2 goes straight through.
    const { error } = await run(
      fileOf(total),
      [
        { drop: true, sentBytes: CHUNK / 2 },
        { drop: true, sentBytes: CHUNK },
        { drop: true, sentBytes: CHUNK / 4 },
        {},
      ],
      { headOffset: null, onProgress: (uploaded) => progress.push(uploaded) }
    );

    expect(error).toBeNull();
    expect(progress.length).toBeGreaterThan(4);
    // The rule the creator actually experiences: the bar never moves backwards.
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
    // And it ends at the whole file, not at whatever the last PATCH happened to
    // report.
    expect(progress[progress.length - 1]).toBe(total);
  });

  it("reports how far the file got, not just how far the dying chunk got", async () => {
    const total = CHUNK * 2;
    const { error } = await run(fileOf(total), [
      {},
      { drop: true, sentBytes: CHUNK / 2 },
    ], { headOffset: null });

    expect(error).toMatchObject({
      chunkIndex: 1,
      offset: CHUNK,
      retryCount: CHUNK_RETRY_DELAYS.length - 1,
      bytesTotal: total,
    });
    // One whole chunk is on the server plus half of the next: cumulative, which
    // is the number the admin panel prints beside the file size.
    expect(error?.bytesSent).toBe(CHUNK + CHUNK / 2);
  });
});

describe("cancelling", () => {
  it("stops a transfer the creator cancelled, and does not retry it", async () => {
    const controller = new AbortController();
    const { error, sends } = await run(
      fileOf(CHUNK),
      [{ abort: true }],
      { signal: controller.signal }
    );

    expect(sends).toHaveLength(1);
    expect(error).toMatchObject({ code: "ABORTED", reason: "cancelled" });
  });

  it("refuses to start a chunk for a signal that is already aborted", async () => {
    // Leaving the page aborts the upload; the next chunk must not be offered,
    // or a slot nobody is watching keeps receiving bytes.
    const controller = new AbortController();
    controller.abort();

    const { error, sends } = await run(fileOf(CHUNK), [{}], { signal: controller.signal });

    expect(error).toMatchObject({ code: "ABORTED" });
    expect(sends).toHaveLength(0);
  });
});

describe("naming the fault", () => {
  it("says offline when the browser knows there is no connection", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { error } = await run(fileOf(CHUNK), [{ drop: true }], { headOffset: null });

    expect(error).toMatchObject({ code: "NETWORK", reason: "offline" });
    expect(error?.message).toMatch(/offline/i);
  });

  it("says the connection dropped when there is a connection to drop", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { error } = await run(fileOf(CHUNK), [{ drop: true }], { headOffset: null });

    expect(error).toMatchObject({ code: "NETWORK", reason: "reset" });
    expect(error?.message).toMatch(/connection dropped/i);
  });

  it("tells a stall apart from a dropped connection", async () => {
    // A dropped connection raises an error event; a suspended tab raises
    // nothing at all. Same code, different reason — and the reason is what
    // tells the creator to come back to the page rather than to go looking for
    // signal. Only the silence watchdog can produce the second one.
    vi.stubGlobal("navigator", { onLine: true });
    const dropped = await run(fileOf(CHUNK), [{ drop: true }], { headOffset: null });
    const silent = await run(fileOf(CHUNK), [{ silent: true }], { headOffset: null });

    expect(dropped.error).toMatchObject({ code: "NETWORK", reason: "reset" });
    expect(silent.error).toMatchObject({ code: "NETWORK", reason: "stall" });
  });
});

describe("the retry sentence", () => {
  it("names the fault and how many attempts are left", () => {
    const base: TusUploadRetryInfo = {
      chunkIndex: 0,
      attempt: 2,
      totalAttempts: CHUNK_RETRY_DELAYS.length,
      offset: 0,
    };

    expect(describeRetry({ ...base, reason: "offline" })).toMatch(/offline/i);
    expect(describeRetry({ ...base, reason: "reset" })).toMatch(/connection dropped/i);
    expect(describeRetry({ ...base, reason: "stall" })).toMatch(/no data moved/i);
    expect(describeRetry({ ...base, reason: "timeout" })).toMatch(/timed out/i);
    expect(describeRetry({ ...base, reason: "provider" })).toMatch(/host refused/i);
    // Every sentence says which attempt this is, so a creator can tell one
    // wobble from a connection that is refusing the same bytes over and over.
    const of = `2 of ${CHUNK_RETRY_DELAYS.length}`;
    for (const reason of ["offline", "reset", "stall", "timeout", "provider"] as const) {
      expect(describeRetry({ ...base, reason })).toContain(of);
    }
    expect(describeRetry(base)).toContain(of);
  });
});
