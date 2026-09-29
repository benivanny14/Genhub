// =============================================================================
// GENHUB - Sending one file by whichever route the server signed for
//
// The bug this file exists to pin is in this application's own failure records:
// a 192 MB upload over a 1.55 Mbps link was sent as ONE request, the connection
// was cut after thirty to sixty seconds, and every retry started from zero — so
// the creator watched a bar run to 88 MB of "progress" for a file that was never
// going to arrive. The parts fix it, and these are the properties that make that
// true rather than hopeful:
//
//   * a file over one part goes as PARTS, each its own request, each to a URL
//     signed for that part number and that upload id only;
//   * the object does not exist until complete names the parts, so a
//     successful-looking transfer that never completes must fail loudly;
//   * a part already stored is not sent again, which is what makes a phone
//     reloading the tab cost one part instead of two gigabytes;
//   * leaving the page gives up the multipart upload, because the parts are real
//     storage and no retry can ever reach them again.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { abandonPendingUpload, sendFileToTarget } from "@/lib/upload-send";
import { signalWithTimeout } from "@/lib/upload-multipart";
import { VideoUploadError } from "@/lib/upload-error";
import { uploadIdentity } from "@/lib/upload-resume";
import type { UploadTarget } from "@/lib/upload-target";

/**
 * A plan whose parts are four bytes, so a ten-byte file is three of them.
 *
 * The client derives its part count from THIS number (lib/upload-multipart.ts),
 * not from the plan's `partCount`, which is why the transport can be tested
 * without allocating eight megabytes per part.
 */
const PART_BYTES = 4;

const multipartTarget = (videoId = "vid-1", uploadId = "UP-1"): UploadTarget => ({
  videoId,
  libraryId: "lib-1",
  presigned: null,
  multipart: {
    uploadId,
    key: `incoming/${videoId}`,
    partSizeBytes: PART_BYTES,
    partCount: 3,
  },
});

const putTarget = (url = "https://acct.r2.cloudflarestorage.com/bucket/incoming/vid-1?sig=x"): UploadTarget => ({
  videoId: "vid-1",
  libraryId: "lib-1",
  presigned: { url, key: "incoming/vid-1", expiresAt: Math.floor(Date.now() / 1000) + 3_600 },
  multipart: null,
});

const fileOf = (bytes: number, name = "scene.mp4", lastModified = 1_700_000_000_000) =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4", lastModified });

interface XhrCall {
  method: string;
  url: string;
  size: number | null;
}

interface XhrStep {
  status?: number;
  outcome?: "load" | "error" | "abort" | "timeout";
  progress?: number[];
}

/** A fake XMLHttpRequest: enough of the real one for this transport. */
function fakeXhr(steps: XhrStep | XhrStep[] = { status: 200 }, calls: XhrCall[] = []) {
  const list = Array.isArray(steps) ? steps : [steps];
  let index = 0;

  return class {
    upload = { onprogress: undefined as ((event: { lengthComputable: boolean; loaded: number }) => void) | undefined };
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = "";
    private url = "";
    private etag: string | null = null;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {
      /* only Content-Type is ever set; the parts need no custom header */
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === "etag" ? this.etag : null;
    }
    abort() {
      this.onabort?.();
    }
    send(body: unknown) {
      const step = list[Math.min(index, list.length - 1)];
      index += 1;
      // From the URL's part number, as the bucket's ETag would be: a resumed
      // upload starts at part 3, and an ETag numbered by request order would
      // silently disagree with what the part actually was.
      const partNumber =
        Number(new URL(this.url).searchParams.get("partNumber")) || index;
      const size = (body as Blob | null)?.size ?? null;
      calls.push({ method: this.method, url: this.url, size });

      const settle = () => {
        for (const loaded of step.progress ?? []) {
          this.upload.onprogress?.({ lengthComputable: true, loaded });
        }
        if ((step.outcome ?? "load") === "load") {
          this.status = step.status ?? 200;
          this.etag = `"etag-${partNumber}"`;
          this.onload?.();
          return;
        }
        if (step.outcome === "error") this.onerror?.();
        else if (step.outcome === "abort") this.onabort?.();
        else this.ontimeout?.();
      };

      queueMicrotask(settle);
    }
  };
}

interface FetchCall {
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * The three routes this transport talks to, answered the way the server does.
 *
 * `completeStatus` and `signStatus` exist so the failure paths can be reached
 * without a bucket: everything else about the shape is copied from the real
 * responses (lib/upload-target.ts).
 */
function stubFetch(options: { completeStatus?: number; signStatus?: number } = {}) {
  const calls: FetchCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });

      if (url === "/api/videos/upload-part") {
        if (options.signStatus && options.signStatus >= 400) {
          return Response.json({ success: false, error: "No." }, { status: options.signStatus });
        }
        const partNumber = body?.partNumber as number;
        return Response.json({
          success: true,
          data: {
            partNumber,
            url: `https://acct.r2.cloudflarestorage.com/bucket/incoming/vid-1?partNumber=${partNumber}&uploadId=UP-1&X-Amz-Signature=sig${partNumber}`,
            key: "incoming/vid-1",
            expiresAt: Math.floor(Date.now() / 1000) + 3_600,
          },
        });
      }

      if (url === "/api/videos/upload-complete") {
        if (options.completeStatus && options.completeStatus >= 400) {
          return Response.json(
            { success: false, error: "The storage would not finish this upload.", code: "INCOMPLETE_UPLOAD" },
            { status: options.completeStatus }
          );
        }
        return Response.json({ success: true, data: { parts: 3 } });
      }

      return Response.json({ success: true, data: { aborted: true, slotRemoved: true } });
    })
  );

  return calls;
}

/** localStorage as the browser has it, since this suite runs without a DOM. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  keys() {
    return [...this.map.keys()];
  }
}

function stubStorage(): MemoryStorage {
  const localStorage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage });
  return localStorage;
}

/** Run a send on a fake clock, so a retry ladder is not waited out for real. */
async function run(
  file: File,
  target: UploadTarget,
  options: Parameters<typeof sendFileToTarget>[2] = {},
  advanceMs = 60_000
): Promise<{ outcome: "ok" } | { outcome: "error"; error: VideoUploadError }> {
  vi.useFakeTimers();
  try {
    const settled = sendFileToTarget(file, target, options).then(
      () => ({ outcome: "ok" as const }),
      (error: VideoUploadError) => ({ outcome: "error" as const, error })
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    return await settled;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  // Whatever a test left registered, so one test's multipart upload cannot be
  // "given up" during the next one.
  abandonPendingUpload();
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------
describe("a file that fits in one request", () => {
  it("goes as one PUT, and never asks the bucket to assemble anything", async () => {
    const calls: XhrCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls));
    const fetchCalls = stubFetch();

    await expect(sendFileToTarget(fileOf(10), putTarget())).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].size).toBe(10);
    // Not one request to our own server: the whole object is one PUT.
    expect(fetchCalls).toHaveLength(0);
  });

  it("records a whole-file failure as a put, and a part failure as a chunk", async () => {
    // The one difference an operator reads: which request died. Kept in one test
    // so the two labels cannot drift apart or be swapped by a later edit.
    vi.stubGlobal("XMLHttpRequest", fakeXhr([{ outcome: "error" }], []));
    stubFetch();

    const wholeFile = await run(fileOf(10), putTarget());
    expect(wholeFile.outcome).toBe("error");
    expect((wholeFile as { error: VideoUploadError }).error.stage).toBe("put");

    const inParts = await run(fileOf(10), multipartTarget());
    expect(inParts.outcome).toBe("error");
    const partFailure = (inParts as { error: VideoUploadError }).error;
    expect(partFailure.stage).toBe("chunk");
    expect(partFailure.offset).toBe(0);
  });

  it("refuses a target with neither transport instead of sending the file anyway", async () => {
    const result = await run(fileOf(10), {
      videoId: "vid-1",
      libraryId: "lib-1",
      presigned: null,
      multipart: null,
    });

    expect(result.outcome).toBe("error");
    expect((result as { error: VideoUploadError }).error.code).toBe("REJECTED");
  });
});

// -----------------------------------------------------------------------------
describe("a file too big for one request", () => {
  it("sends it in parts, each to a URL signed for that part", async () => {
    const calls: XhrCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls));
    stubFetch();

    await expect(run(fileOf(10), multipartTarget())).resolves.toEqual({ outcome: "ok" });

    // Three parts of four, four and two bytes — the last one is the remainder,
    // and it is what keeps a file whose size is not a multiple of the part from
    // arriving with its tail missing.
    expect(calls.map((call) => [call.method, call.size])).toEqual([
      ["PUT", 4],
      ["PUT", 4],
      ["PUT", 2],
    ]);
    expect(calls.map((call) => new URL(call.url).searchParams.get("partNumber"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    // Every part URL is different, because the part number is inside the
    // signature: a URL minted for part 1 is refused as part 2 (measured on the
    // live bucket — see tests/r2-sign.test.ts).
    expect(new Set(calls.map((call) => call.url)).size).toBe(3);
  });

  it("names every part at completion, which is what makes the object exist", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, []));
    const fetchCalls = stubFetch();

    await run(fileOf(10), multipartTarget());

    const complete = fetchCalls.filter((call) => call.url === "/api/videos/upload-complete");
    expect(complete).toHaveLength(1);
    expect(complete[0].body).toEqual({
      videoId: "vid-1",
      uploadId: "UP-1",
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
  });

  it("reports progress from bytes the bucket acknowledged, never from what the browser buffered", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200, progress: [4] }, []));
    stubFetch();

    const seen: Array<[number, number]> = [];
    await run(fileOf(10), multipartTarget(), {
      onProgress: (uploaded, total) => seen.push([uploaded, total]),
    });

    // Four bytes per part, in order, ending at the file's size. A part in flight
    // can add at most its own size — which is the property the single-PUT
    // progress bar did not have, and the reason it read 88 MB of a 192 MB file
    // that had barely started.
    expect(seen).toEqual([
      [0, 10],
      [4, 10],
      [4, 10],
      [8, 10],
      [8, 10],
      [10, 10],
      [10, 10],
      [10, 10],
    ]);
  });

  it("fails without completing when a part cannot be sent at all", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr([{ outcome: "error" }], []));
    const fetchCalls = stubFetch();

    const result = await run(fileOf(10), multipartTarget());

    expect(result.outcome).toBe("error");
    const failure = (result as { error: VideoUploadError }).error;
    // The record an operator reads: which part, from which offset, and how long
    // each attempt lasted.
    expect(failure.offset).toBe(0);
    expect(failure.reason).toBe("reset");
    expect(failure.attemptMs).toHaveLength(4);
    // CHUNK, not PUT. The request that died is a slice of the file, and the
    // shared PUT transport stamps its own failures `put` because for a
    // whole-file upload that is what they are. Reported unchanged, the two read
    // identically in the admin panel and need opposite answers: "retry the part"
    // against "this link cannot carry this file".
    expect(failure.stage).toBe("chunk");
    // Never completed: an object assembled from a list with a hole in it is a
    // video that plays with its middle missing.
    expect(fetchCalls.some((call) => call.url === "/api/videos/upload-complete")).toBe(false);
  });

  it("forgets the resume record when the bucket will not assemble the parts", async () => {
    const store = stubStorage();
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, []));
    stubFetch({ completeStatus: 409 });

    const file = fileOf(10);
    const result = await run(file, multipartTarget());

    expect(result.outcome).toBe("error");
    expect((result as { error: VideoUploadError }).error.status).toBe(409);
    // A 409 is the one answer a retry cannot improve: the list this browser
    // recorded does not match what the bucket holds. Keeping the record would
    // make every retry replay the same refusal, so it is dropped and the retry
    // re-sends the parts into the same upload id.
    expect(store.getItem("genhub.multipart.resume")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe("an upload that was interrupted before", () => {
  it("sends only the parts the bucket does not already hold", async () => {
    const store = stubStorage();
    const file = fileOf(10);
    store.setItem(
      "genhub.multipart.resume",
      JSON.stringify({
        identity: uploadIdentity(file),
        videoId: "vid-1",
        uploadId: "UP-1",
        key: "incoming/vid-1",
        partSizeBytes: PART_BYTES,
        partCount: 3,
        fileSize: 10,
        fileName: file.name,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
        at: Date.now(),
      })
    );

    const calls: XhrCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls));
    const fetchCalls = stubFetch();

    const resumed: number[] = [];
    await run(file, multipartTarget(), { onResume: (parts) => resumed.push(parts) });

    // One part on the wire, not the file: this is what a phone that reloaded the
    // tab gets, instead of starting a two-gigabyte transfer again.
    expect(calls).toHaveLength(1);
    expect(calls[0].size).toBe(2);
    expect(resumed).toEqual([2]);

    const complete = fetchCalls.find((call) => call.url === "/api/videos/upload-complete");
    expect(complete?.body?.parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ]);
  });

  it("will not resume into a record for a DIFFERENT upload of the same file", async () => {
    const store = stubStorage();
    const file = fileOf(10);
    store.setItem(
      "genhub.multipart.resume",
      JSON.stringify({
        identity: uploadIdentity(file),
        videoId: "vid-1",
        uploadId: "UP-OLD",
        key: "incoming/vid-1",
        partSizeBytes: PART_BYTES,
        partCount: 3,
        fileSize: 10,
        fileName: file.name,
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
        at: Date.now(),
      })
    );

    const calls: XhrCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls));
    stubFetch();

    await run(file, multipartTarget("vid-1", "UP-1"));

    // The parts of UP-OLD are held under an upload id this run cannot complete,
    // so they are worthless here and the file is sent whole.
    expect(calls).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
describe("the deadline on a request that must not hang", () => {
  it("trips when the deadline passes, without needing AbortSignal.timeout", () => {
    vi.useFakeTimers();
    try {
      const deadline = signalWithTimeout(undefined, 1_000);
      expect(deadline.signal.aborted).toBe(false);

      vi.advanceTimersByTime(1_000);
      expect(deadline.signal.aborted).toBe(true);
      deadline.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("trips when the creator cancels first", () => {
    const controller = new AbortController();
    const deadline = signalWithTimeout(controller.signal, 60_000);

    controller.abort();

    expect(deadline.signal.aborted).toBe(true);
    deadline.release();
  });

  it("is already tripped when the creator has already cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    const deadline = signalWithTimeout(controller.signal, 60_000);

    // Not a listener registered on a signal that already fired: a request made
    // after a cancel must not be sent at all.
    expect(deadline.signal.aborted).toBe(true);
    deadline.release();
  });

  it("stops counting once it is released, so a finished request leaves no timer", () => {
    vi.useFakeTimers();
    try {
      const deadline = signalWithTimeout(undefined, 1_000);
      deadline.release();

      vi.advanceTimersByTime(10_000);
      expect(deadline.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -----------------------------------------------------------------------------
describe("leaving the page", () => {
  it("gives up the multipart upload, because the parts are real storage", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ outcome: "error" }, []));
    const fetchCalls = stubFetch();

    await run(fileOf(10), multipartTarget());

    abandonPendingUpload();

    const abort = fetchCalls.find((call) => call.url === "/api/videos/upload-abort");
    expect(abort?.body).toEqual({ videoId: "vid-1", uploadId: "UP-1" });
  });

  it("has nothing to give up once the upload finished", async () => {
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, []));
    const fetchCalls = stubFetch();

    await run(fileOf(10), multipartTarget());
    abandonPendingUpload();

    expect(fetchCalls.some((call) => call.url === "/api/videos/upload-abort")).toBe(false);
  });
});
