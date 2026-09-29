// =============================================================================
// GENHUB - The whole-file upload (one presigned PUT to the bucket)
//
// The transport the creator asked for, and the one that changed the shape of an
// uploader built around resuming: with no offset to resume from, EVERY retry
// re-sends the whole file. That is the property these tests exist to pin —
//
//   * the ladder is short and must stay short (three tries, ~100 MB of the
//     creator's data at worst) rather than inheriting the two-and-a-half-minute
//     patience that is only cheap when the bytes already on the server are kept;
//   * the progress bar must never walk backwards between attempts, because from
//     the creator's side a bar that restarts reads as the upload having failed;
//   * a failure must carry the same shape as the resumable path's — code, reason,
//     stage, byte counts, per-attempt timings — or the admin panel ends up
//     telling two stories about one provider.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PUT_RETRY_DELAYS,
  uploadFileWithPut,
  type PutUploadOptions,
  type PutUploadTarget,
} from "@/lib/upload-put";
import { VideoUploadError } from "@/lib/upload-error";

const target: PutUploadTarget = {
  url:
    "https://acct.r2.cloudflarestorage.com/genhub-uploads/incoming/vid-1" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
  expiresAt: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
};

const fileOf = (bytes: number, name = "scene.mp4") =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

/** A File whose only real property is its size — 2 GB must not be allocated. */
const bigFileOf = (bytes: number) =>
  ({ size: bytes, type: "video/mp4", name: "scene.mp4" }) as unknown as File;

interface PutCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** One attempt's behaviour. Each new XHR consumes the next step, then repeats. */
interface XhrStep {
  status?: number;
  responseText?: string;
  /** Bytes acknowledged, in order — what `xhr.upload.onprogress` reports. */
  progress?: number[];
  outcome?: "load" | "error" | "abort" | "timeout";
  /** How long the attempt "takes". Under fake timers this moves the clock. */
  settleAfterMs?: number;
  throwOnSend?: Error;
}

/**
 * A fake XMLHttpRequest that behaves like the parts this transport uses.
 *
 * `steps` is per-ATTEMPT rather than per-instance because the interesting cases
 * are sequences: a reset followed by a success, or the same 423 twice. The last
 * step repeats once the list is exhausted, so a doomed upload does not need
 * three identical entries written out.
 */
function fakeXhr(steps: XhrStep | XhrStep[], calls: PutCall[] = []) {
  const list = Array.isArray(steps) ? steps : [steps];
  let index = 0;

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
    private method = "";
    private url = "";

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    abort() {
      this.onabort?.();
    }
    send(body: unknown) {
      const step = list[Math.min(index, list.length - 1)];
      index += 1;

      calls.push({ method: this.method, url: this.url, headers: { ...this.headers }, body });
      if (step.throwOnSend) throw step.throwOnSend;

      const settle = () => {
        for (const loaded of step.progress ?? []) {
          this.upload.onprogress?.({ lengthComputable: true, loaded });
        }
        if ((step.outcome ?? "load") === "load") {
          this.status = step.status ?? 200;
          this.responseText = step.responseText ?? "";
          this.onload?.();
          return;
        }
        if (step.outcome === "error") this.onerror?.();
        else if (step.outcome === "abort") this.onabort?.();
        else this.ontimeout?.();
      };

      if (step.settleAfterMs) setTimeout(settle, step.settleAfterMs);
      else queueMicrotask(settle);
    }
  };
}

/**
 * Run one upload to its end on a fake clock.
 *
 * The retry ladder includes sleeps of three and ten seconds, and the watchdog
 * window is minutes long, so the clock is moved rather than waited on. The
 * promise is handled the moment it exists — the rejection lands while the clock
 * is being advanced, and a bare promise would be reported as unhandled long
 * before the assertion sees it.
 */
async function run(
  file: File,
  options: PutUploadOptions = {},
  advanceMs = 5 * 60_000
): Promise<{ outcome: "ok" | "error"; error?: VideoUploadError }> {
  vi.useFakeTimers();
  try {
    const settled = uploadFileWithPut(file, target, options).then(
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
  vi.unstubAllGlobals();
});

describe("uploading the whole file in one PUT", () => {
  it("sends one PUT to the URL it was given, with an octet-stream body", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 201 }, calls) as unknown as typeof XMLHttpRequest);
    const file = fileOf(1_000);

    await expect(uploadFileWithPut(file, target)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    // The token is already inside it, which is how the Worker can authorize
    // before it reads a byte.
    expect(calls[0].url).toBe(target.url);
    expect(calls[0].headers).toEqual({ "Content-Type": "application/octet-stream" });
    // The FILE, not a slice: one request, no chunk bookkeeping.
    expect(calls[0].body).toBe(file);
    // Never the library key — that lives in the Worker and nowhere else.
    expect(Object.keys(calls[0].headers).map((h) => h.toLowerCase())).not.toContain("accesskey");
  });

  it("reports bytes as they are acknowledged, and finishes at the file size", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ status: 200, progress: [250, 500, 1_000] }, calls) as unknown as typeof XMLHttpRequest
    );

    const seen: Array<[number, number]> = [];
    await uploadFileWithPut(fileOf(1_000), target, {
      onProgress: (uploaded, total) => seen.push([uploaded, total]),
    });

    expect(seen).toEqual([
      [250, 1_000],
      [500, 1_000],
      [1_000, 1_000],
      // Reported again once the request is done. Deliberate: a browser coalesces
      // its final progress event, so without this last figure a success could
      // leave the bar at 98% with nothing on screen to explain it.
      [1_000, 1_000],
    ]);
  });

  it("never lets the bar walk backwards when an attempt is re-sent", async () => {
    // The first attempt gets 60% of the way and the connection resets; the
    // second starts from zero, as it must — there is nothing to resume from.
    // What the creator sees must not go back to 30%.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        [
          { outcome: "error", progress: [600], settleAfterMs: 50 },
          { outcome: "load", status: 200, progress: [300], settleAfterMs: 50 },
        ],
        calls
      ) as unknown as typeof XMLHttpRequest
    );

    const seen: number[] = [];
    const result = await run(fileOf(1_000), {
      onProgress: (uploaded) => seen.push(uploaded),
    });

    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(seen).not.toContain(300);
    expect(seen).toEqual([600, 600, 1_000]);
  });
});

describe("the retry ladder of a transport with nothing to resume from", () => {
  it("is three attempts, seconds apart — not the resumable path's two-and-a-half minutes", async () => {
    // Every rung here re-sends the ENTIRE file on the creator's data plan, so
    // patience is expensive in a way it is not when the bytes already on the
    // server are kept. If this ever grows, it grows their bill.
    expect([...PUT_RETRY_DELAYS]).toEqual([0, 3_000, 10_000]);
  });

  it("re-sends the whole file, records each attempt, and says it gave up", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ outcome: "error", progress: [400], settleAfterMs: 500 }, calls) as unknown as typeof XMLHttpRequest
    );

    const retries: Array<{ attempt: number; totalAttempts: number; reason?: string }> = [];
    const result = await run(fileOf(1_000), { onRetry: (info) => retries.push(info) });

    expect(result.outcome).toBe("error");
    const error = result.error!;
    expect(error).toMatchObject({
      code: "NETWORK",
      // The transport is part of the verdict: a "chunk" failure and a "put"
      // failure are different faults that read the same otherwise.
      stage: "put",
      reason: "reset",
      retryCount: PUT_RETRY_DELAYS.length - 1,
      bytesSent: 400,
      bytesTotal: 1_000,
    });
    // Three attempts, each lasting the half second it really took. The backoff
    // sleeps we chose are deliberately absent — a wait we chose is not evidence
    // about the connection.
    expect(error.attemptMs).toEqual([500, 500, 500]);
    // Three attempts, the whole file each time.
    expect(calls).toHaveLength(PUT_RETRY_DELAYS.length);
    // The creator is told between attempts, not left watching a still bar.
    // Fired after every failed attempt, the last one included — the same shape
    // as the resumable path, so the toast says the same thing on both
    // transports and a reader of one already understands the other.
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(retries.every((r) => r.totalAttempts === PUT_RETRY_DELAYS.length)).toBe(true);
  });

  it("rides out a transient 423 and finishes without telling the creator", async () => {
    // Bunny (and any proxy in front of it) can answer 423/429 while it lets go of
    // a lock. That is not a rejection, and it must not end the upload.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        [
          { status: 423, responseText: "locked" },
          { status: 200 },
        ],
        calls
      ) as unknown as typeof XMLHttpRequest
    );

    const retries: unknown[] = [];
    const result = await run(fileOf(1_000), { onRetry: (info) => retries.push(info) });

    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(retries).toHaveLength(1);
  });
});

describe("what the bucket's answer means", () => {
  it("treats a 413 as a size problem, not as a connection problem", async () => {
    // Kept after the move to the bucket: the code is now theirs, not ours, and
    // the classification still has to call it a size problem rather than a
    // connection one.
    // The client is supposed to check the size first and take the resumable
    // path, so reaching here means two ceilings disagree. Saying so plainly is
    // worth more than another NETWORK row.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ status: 413, responseText: '{"error":"too large"}' }, calls) as unknown as typeof XMLHttpRequest
    );

    const result = await run(fileOf(2_000));

    expect(result.outcome).toBe("error");
    expect(result.error).toMatchObject({
      code: "UNSUPPORTED",
      stage: "put",
      reason: "provider",
      status: 413,
      bytesTotal: 2_000,
    });
    // The refusal now comes from the bucket rather than from a proxy of ours, so
    // the sentence says so: nothing we run receives the body any more.
    expect(result.error!.message).toMatch(/storage service/i);
    // One attempt: retrying a file that is too large just sends it again.
    expect(calls).toHaveLength(1);
  });

  it("does not retry a refusal, and keeps the provider's own words", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        { status: 401, responseText: '{"error":"This upload is no longer authorized."}' },
        calls
      ) as unknown as typeof XMLHttpRequest
    );

    const result = await run(fileOf(1_000));

    expect(result.error).toMatchObject({
      code: "REJECTED",
      stage: "put",
      status: 401,
    });
    expect(result.error!.message).toContain("HTTP 401");
    expect(result.error!.providerBody).toContain("no longer authorized");
    expect(calls).toHaveLength(1);
  });

  it("calls a 500 a network-class failure so it is retried", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ status: 500, responseText: "boom" }, calls) as unknown as typeof XMLHttpRequest
    );

    const result = await run(fileOf(1_000));

    expect(result.error).toMatchObject({ code: "NETWORK", status: 500, stage: "put" });
    expect(calls).toHaveLength(PUT_RETRY_DELAYS.length);
  });

  it("separates a device that cannot read the file from a dropped connection", async () => {
    // `xhr.send` throwing is the same local fault the resumable path probes for
    // — and this transport hands the WHOLE file to the socket, so it happens
    // here too. It must not read as "the connection dropped": nothing was ever
    // sent, and no amount of patience would help.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        {
          throwOnSend: Object.assign(new Error("The requested file could not be read."), {
            name: "NotReadableError",
          }),
        },
        calls
      ) as unknown as typeof XMLHttpRequest
    );

    const result = await run(fileOf(5_804_475));

    expect(result.error).toMatchObject({
      code: "UNSUPPORTED",
      stage: "put",
      reason: "preflight",
      bytesSent: 0,
      bytesTotal: 5_804_475,
    });
    expect(result.error!.message).toContain("NotReadableError");
    // The same wording as the resumable path, deliberately: one story for one
    // fault whichever transport met it — and no instruction to go and put the
    // file in a folder the app has no business requiring.
    expect(result.error!.message).toMatch(/Files app/);
    expect(result.error!.message).not.toMatch(/Downloads/);
    expect(result.error!.providerBody).toBe(
      "NotReadableError: The requested file could not be read."
    );
    // The device will refuse it just as firmly the second time.
    expect(calls).toHaveLength(1);
  });

  it("says offline when the browser already knows it is offline", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ outcome: "error" }, calls) as unknown as typeof XMLHttpRequest);
    vi.stubGlobal("navigator", { onLine: false });

    const result = await run(fileOf(1_000));

    expect(result.error).toMatchObject({ reason: "offline", stage: "put" });
    expect(result.error!.message).toMatch(/offline/i);
  });

  it("blames the connection rather than the device when there is a link", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ outcome: "error" }, calls) as unknown as typeof XMLHttpRequest);
    vi.stubGlobal("navigator", { onLine: true });

    const result = await run(fileOf(1_000));

    expect(result.error).toMatchObject({ reason: "reset", message: "The connection dropped during upload." });
  });

  it("calls a stall a stall, and a silence a timeout", async () => {
    const timeoutCalls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ outcome: "timeout" }, timeoutCalls) as unknown as typeof XMLHttpRequest
    );

    const timedOut = await run(fileOf(1_000));
    expect(timedOut.error).toMatchObject({ reason: "timeout", code: "NETWORK", stage: "put" });
  });

  it("names the device when a refused file never put a byte on the wire", async () => {
    // This transport had no probe at all, so an unreadable pick used to report
    // "the connection dropped" here after three attempts — the same wrong sentence
    // the resumable path printed. Both paths now read the same two facts before
    // blaming the phone: the device refused a scripted read, and nothing moved.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ outcome: "error" }, calls) as unknown as typeof XMLHttpRequest
    );
    const unreadable = {
      name: "1000371423.mp4",
      size: 5_804_475,
      type: "video/mp4",
      slice: () => ({
        size: 1024,
        arrayBuffer: () =>
          Promise.reject(
            Object.assign(new Error("The requested file could not be read."), {
              name: "NotReadableError",
            })
          ),
      }),
    } as unknown as File;

    const result = await run(unreadable);

    expect(result.error).toMatchObject({
      code: "UNSUPPORTED",
      stage: "put",
      reason: "preflight",
      bytesSent: 0,
      bytesTotal: 5_804_475,
    });
    expect(result.error!.message).toContain("NotReadableError");
    expect(result.error!.message).toMatch(/Files app/);
    expect(result.error!.providerBody).toBe(
      "NotReadableError: The requested file could not be read."
    );
    expect(calls).toHaveLength(PUT_RETRY_DELAYS.length);
  });

  it("still blames the connection when a refused file did move bytes", async () => {
    // The other direction, and the one that keeps this from being dangerous: bytes
    // acknowledged prove the file was readable, so the probe's opinion is worth
    // nothing here and the phone must not be blamed for a dropped link.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr({ outcome: "error", progress: [400] }, calls) as unknown as typeof XMLHttpRequest
    );
    const unreadable = {
      name: "1000371423.mp4",
      size: 1_000,
      type: "video/mp4",
      slice: () => ({
        size: 1024,
        arrayBuffer: () => Promise.reject(new Error("The requested file could not be read.")),
      }),
    } as unknown as File;

    const result = await run(unreadable);

    expect(result.error).toMatchObject({ code: "NETWORK", reason: "reset", bytesSent: 400 });
    expect(result.error!.message).toBe("The connection dropped during upload.");
  });

  it("reports a cancellation as a cancellation, not as a fault", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls) as unknown as typeof XMLHttpRequest);

    const controller = new AbortController();
    controller.abort();

    const result = await run(fileOf(1_000), { signal: controller.signal });

    expect(result.error).toMatchObject({ code: "ABORTED", stage: "put", reason: "cancelled" });
    // Refused before the request was built: an aborted upload must not send.
    expect(calls).toHaveLength(0);
  });
});

describe("the guards that run before anything is sent", () => {
  it("refuses an empty file", async () => {
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls) as unknown as typeof XMLHttpRequest);

    const result = await run(fileOf(0));

    expect(result.error).toMatchObject({
      code: "UNSUPPORTED",
      reason: "preflight",
      stage: "put",
      bytesTotal: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("has no file-size ceiling any more", async () => {
    // The ceiling existed because a proxy had to receive the body, and Cloudflare
    // refuses a request body over 100 MB on Free and Pro. A presigned URL is not
    // a proxy: the browser writes to the bucket and the size of the file decides
    // nothing. This file is larger than the old limit on purpose — under the old
    // rule it would have been refused before a byte was sent.
    const calls: PutCall[] = [];
    vi.stubGlobal("XMLHttpRequest", fakeXhr({ status: 200 }, calls) as unknown as typeof XMLHttpRequest);
    const big = 140 * 1024 * 1024;

    const result = await run(bigFileOf(big));

    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("names an expired signature instead of blaming the file", async () => {
    // A 403 part-way through a slow upload on a phone is the bucket refusing a
    // signature that ran out, not a bad video — and it is the one provider answer
    // a creator can act on, so it gets its own sentence and is not retried.
    const calls: PutCall[] = [];
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        { status: 403, responseText: "Request has expired" },
        calls
      ) as unknown as typeof XMLHttpRequest
    );

    const result = await run(fileOf(2048));

    expect(result.error).toMatchObject({ code: "REJECTED", status: 403, stage: "put" });
    expect(result.error!.message).toMatch(/permission allowed/i);
    // Not retryable: the same URL cannot start working again.
    expect(calls).toHaveLength(1);
  });
});
