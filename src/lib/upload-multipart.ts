// =============================================================================
// GENHUB - The multipart transport: a video that arrives in pieces
//
// This replaces the single whole-file PUT for every file too big for one part,
// and the reason is in this application's own failure records. A 192 MB file over
// a 1.55 Mbps link needs seventeen minutes; the connection was cut after thirty
// to sixty seconds; and a transfer with no offset to resume from loses everything
// it sent. The creator watched a bar freeze at the percentage their browser had
// BUFFERED — a figure that runs far ahead of the wire — and then read "The
// connection dropped during upload.", three times, for a file that was never
// going to arrive.
//
// Three properties change that, and each is why one of the rules below exists:
//
//   * A reset costs ONE PART. A part is 8 MiB, its URL is signed for that part
//     number and that upload id (lib/r2-sign.ts), and its retry re-sends nothing
//     else. The parts that already arrived are held by the bucket under the same
//     upload id.
//   * PROGRESS BECOMES TRUE. Completed parts are bytes the bucket has
//     acknowledged, so the bar can no longer run ahead of the transfer: it is
//     `completed bytes + this part's own progress`, and the second term is
//     bounded by 8 MiB no matter how much the browser has buffered.
//   * A RELOAD IS NOT A RESTART. Every finished part is written down
//     (lib/upload-resume.ts) and offered back to the same file, which is the case
//     a phone makes routine.
//
// PARTS ARE SENT IN ORDER, one at a time. Not for correctness — R2 accepts parts
// in any order — but because the alternative is several 8 MiB uploads competing
// for a link that is already the bottleneck, and because the progress figure a
// creator reads is only honest when one part is moving at a time.
// =============================================================================

import { putBlob } from "./upload-put";
import {
  clearMultipartResume,
  loadMultipartResume,
  saveMultipartResume,
  uploadIdentity,
} from "./upload-resume";
import {
  isRetryableUploadFailure,
  VideoUploadError,
  type UploadRetryInfo,
} from "./upload-error";
import type { CompletedPart, UploadTarget } from "./upload-target";

/**
 * How many times one PART is retried, and how long between tries.
 *
 * Longer than the whole-file ladder, and affordable precisely because a part is
 * one part: three attempts at a single PUT of a 192 MB file spends 192 MB per
 * rung, while four attempts at 8 MiB spends eight. Four rungs is also chosen to
 * outlast the fault this was built for — a connection cut every thirty to sixty
 * seconds — where a three-rung ladder over a seventeen-minute transfer gives up
 * before the first quiet minute.
 */
export const PART_RETRY_DELAYS = [0, 2_000, 5_000, 12_000] as const;

/** How long the request FOR a part's URL may take before it is abandoned. */
const SIGN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A signal that trips when the creator cancels OR when the deadline passes.
 *
 * Hand-rolled rather than `AbortSignal.any` and `AbortSignal.timeout`, and the
 * reason is the device this transport was built for. `AbortSignal.any` is Chrome
 * 116 (August 2023) and `AbortSignal.timeout` is Chrome 103, so on an older
 * Android browser — the 3G, 1.55 Mbps, 800 ms phone in this application's own
 * failure records — either call is a TypeError that fails EVERY multipart
 * upload, on exactly the devices whose connections the parts exist to survive.
 * An AbortController plus a setTimeout does the same job everywhere.
 *
 * The caller MUST release the result, or the timer outlives the request.
 */
export function signalWithTimeout(
  signal: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface MultipartUploadOptions {
  /** Bytes acknowledged by the bucket, out of the file's size. Never walks back. */
  onProgress?: (uploaded: number, total: number) => void;
  /** Before a part is retried, so the screen can say why it is waiting. */
  onRetry?: (info: UploadRetryInfo) => void;
  /** How many parts a previous run already delivered, once, at the start. */
  onResume?: (partsAlreadySent: number) => void;
  signal?: AbortSignal;
}

export interface MultipartUploadResult {
  parts: CompletedPart[];
  /** Parts this run did not have to send, because an earlier one had. */
  resumedParts: number;
}

function abortError(): VideoUploadError {
  return new VideoUploadError("ABORTED", "Upload cancelled", undefined, {
    stage: "chunk",
    reason: "cancelled",
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Ask the server to sign one part. */
async function signPart(
  videoId: string,
  uploadId: string,
  partNumber: number,
  signal?: AbortSignal
): Promise<{ url: string; expiresAt: number }> {
  const deadline = signalWithTimeout(signal, SIGN_REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("/api/videos/upload-part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, uploadId, partNumber }),
      signal: deadline.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && signal?.aborted) {
      throw abortError();
    }
    // The signing request never produced an answer. It is a small request to our
    // own server, so this is the connection, not the size of anything.
    throw new VideoUploadError("NETWORK", "The connection dropped while preparing the upload.", undefined, {
      stage: "reserve",
      reason: "reset",
    });
  } finally {
    deadline.release();
  }

  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: string; data?: { url?: string; expiresAt?: number } }
    | null;

  if (!res.ok || !data?.success || !data.data?.url || typeof data.data.expiresAt !== "number") {
    // 401/403 mean the creator's session, 429 means the ceiling, 5xx means us. A
    // retry of the SAME part cannot fix any of them, so none of them spends a rung
    // of the ladder — the page's own error is what the creator acts on.
    throw new VideoUploadError(
      res.status === 401 || res.status === 403 ? "REJECTED" : "NETWORK",
      data?.error || "Could not prepare the upload. Please try again.",
      res.status,
      { stage: "reserve", reason: "provider" }
    );
  }

  return { url: data.data.url, expiresAt: data.data.expiresAt };
}

/**
 * Send one file as parts, retrying each part on its own, and return the list R2
 * needs in order to assemble it.
 *
 * Throws VideoUploadError with the same vocabulary every other upload failure
 * uses — code, reason, stage, byte counts, per-attempt timings — so a multipart
 * failure still leaves a record an operator can read (see
 * lib/services/upload-failure.service.ts).
 */
export async function uploadFileInParts(
  file: File,
  target: Pick<UploadTarget, "videoId"> & NonNullable<UploadTarget["multipart"]>,
  options: MultipartUploadOptions = {}
): Promise<MultipartUploadResult> {
  const { onProgress, onRetry, onResume, signal } = options;

  if (!file.size) {
    throw new VideoUploadError("UNSUPPORTED", "That file is empty.", undefined, {
      stage: "chunk",
      reason: "preflight",
    });
  }

  const { videoId, uploadId, partSizeBytes } = target;

  // Computed from the file rather than taken from the plan: the server sized the
  // plan from the size the client REPORTED, and the file in hand is the truth. A
  // disagreement is not an error — R2 does not know how many parts an upload will
  // have until it is completed — but it cannot be allowed to leave the last bytes
  // of a file unsent.
  const partCount = Math.max(1, Math.ceil(file.size / partSizeBytes));
  const partBytes = (partNumber: number) =>
    Math.max(0, Math.min(partSizeBytes, file.size - (partNumber - 1) * partSizeBytes));

  // What an earlier run already delivered, and only when it was for THIS upload:
  // a record whose upload id differs is a record for a different upload of the
  // same file, and its parts are held somewhere this run cannot complete.
  const identity = uploadIdentity(file);
  const stored = loadMultipartResume(identity);
  const resumable =
    stored && stored.uploadId === uploadId && stored.partSizeBytes === partSizeBytes ? stored : null;

  const delivered = new Map<number, string>();
  if (resumable) {
    for (const part of resumable.parts) {
      if (part.partNumber >= 1 && part.partNumber <= partCount) {
        delivered.set(part.partNumber, part.etag);
      }
    }
  }

  if (resumable && delivered.size > 0) onResume?.(delivered.size);

  let completedBytes = 0;
  for (const partNumber of delivered.keys()) completedBytes += partBytes(partNumber);

  let highest = completedBytes;
  const report = (uploaded: number) => {
    highest = Math.max(highest, uploaded);
    onProgress?.(Math.min(highest, file.size), file.size);
  };
  report(completedBytes);

  const persist = () => {
    saveMultipartResume({
      identity,
      videoId,
      uploadId,
      key: target.key,
      partSizeBytes,
      partCount,
      fileSize: file.size,
      fileName: file.name,
      parts: [...delivered.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
    });
  };

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (delivered.has(partNumber)) continue;
    if (signal?.aborted) throw abortError();

    const size = partBytes(partNumber);
    const slice = file.slice((partNumber - 1) * partSizeBytes, (partNumber - 1) * partSizeBytes + size);
    const attemptMs: number[] = [];
    let lastError: VideoUploadError | null = null;

    for (let attempt = 0; attempt < PART_RETRY_DELAYS.length; attempt += 1) {
      if (PART_RETRY_DELAYS[attempt] > 0) await sleep(PART_RETRY_DELAYS[attempt], signal);

      const startedAt = Date.now();
      try {
        const signed = await signPart(videoId, uploadId, partNumber, signal);
        const { etag } = await putBlob(slice, signed, {
          onProgress: (loaded) => report(completedBytes + loaded),
          signal,
        });

        // A part the bucket accepted without returning an ETag cannot be declared
        // at completion, so it is a failure now rather than a video that will not
        // assemble later. Measured on the live bucket: the header IS exposed
        // (ExposeHeader: ETag), so this is a bucket misconfiguration, not a
        // browser limitation.
        if (!etag) {
          throw new VideoUploadError(
            "REJECTED",
            "The storage service accepted part of the upload without naming it, so the video cannot be assembled.",
            undefined,
            { stage: "chunk", reason: "provider" }
          );
        }

        delivered.set(partNumber, etag);
        completedBytes += size;
        highest = Math.max(highest, completedBytes);
        persist();
        report(completedBytes);
        lastError = null;
        break;
      } catch (error) {
        const failure =
          error instanceof VideoUploadError
            ? error
            : new VideoUploadError("NETWORK", "Upload failed", undefined, {
                stage: "chunk",
                reason: "reset",
              });

        // A PART IS A CHUNK, AND THE RECORD HAS TO SAY SO. The request that died
        // is a slice of the file, and lib/upload-put.ts — shared by both
        // transports — stamps its own failures `put`, because for the whole-file
        // transport that is exactly what they are. Left as they come, a multipart
        // failure and a whole-file failure read identically in the admin panel,
        // and the two need opposite answers: one says a part can be retried, the
        // other says this link cannot carry this file at all.
        if (failure.stage === "put") failure.stage = "chunk";

        attemptMs.push(Date.now() - startedAt);

        if (failure.code === "ABORTED") throw failure;

        if (!isRetryableUploadFailure(failure)) {
          failure.bytesSent = highest;
          failure.bytesTotal = file.size;
          failure.offset = (partNumber - 1) * partSizeBytes;
          failure.retryCount = attempt;
          failure.attemptMs = attemptMs;
          throw failure;
        }

        lastError = failure;
        onRetry?.({
          attempt: attempt + 1,
          totalAttempts: PART_RETRY_DELAYS.length,
          offset: (partNumber - 1) * partSizeBytes,
          reason: failure.reason,
        });
      }
    }

    if (lastError) {
      // The offset, the ladder and the timings, so the record says which part
      // died and whether the attempts were long (a transfer being cut) or
      // instantaneous (a host refusing the request).
      lastError.bytesSent = highest;
      lastError.bytesTotal = file.size;
      lastError.offset = (partNumber - 1) * partSizeBytes;
      lastError.retryCount = PART_RETRY_DELAYS.length - 1;
      lastError.attemptMs = attemptMs;
      throw lastError;
    }
  }

  report(file.size);

  return {
    parts: [...delivered.entries()]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber),
    resumedParts: resumable ? resumable.parts.length : 0,
  };
}

/**
 * Tell the server to abandon an upload whose parts can never be assembled.
 *
 * Called for a failure a retry cannot fix — a refused signature, a host that will
 * not take the file — and never for one a retry can: the parts a failed attempt
 * already delivered are what makes Retry cost one part instead of the file, so
 * abandoning them is the exact opposite of what the creator wants next.
 *
 * Never throws, and nothing waits on it. The creator is already being told the
 * upload failed, and an abandoned-upload cleanup that itself failed must not
 * become a second error on screen.
 */
export function abandonMultipartUpload(videoId: string, uploadId: string): void {
  void fetch("/api/videos/upload-abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, uploadId }),
    keepalive: true,
  }).catch(() => undefined);
}

/** Forget this file's resume record — after a completion, or after a cancel. */
export function forgetMultipartResume(file: File): void {
  // Only clears when the record is for THIS file, so a second creator on the same
  // device does not lose an interrupted upload to somebody else's finished one.
  if (loadMultipartResume(uploadIdentity(file))) clearMultipartResume();
}
