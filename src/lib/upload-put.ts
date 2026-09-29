// =============================================================================
// GENHUB - Whole-file upload to the bucket (one presigned PUT)
//
// The transport the creator asked for: one standard HTTP PUT, one progress bar,
// no chunk bookkeeping, no resumable endpoint. The browser sends the file
// straight to a storage bucket with a presigned URL the server signed for that
// one object and that one moment (lib/r2-sign.ts), so no credential of ours is
// in the browser at all and no server of ours receives the bytes — which is what
// lets this path accept a file of any size.
//
// WHAT THIS COSTS, HONESTLY. There is no offset to resume from. A connection
// that dies at 90% of a 90 MB file has sent 81 MB that are now gone, so the
// retry ladder here is deliberately SHORT — three attempts, ten seconds apart,
// about a hundred megabytes of the creator's data at worst — instead of the
// patient ladder a resumable upload can afford, because patience is cheap when
// the bytes already on the server are kept.
//
// WHAT SOFTENS THAT. The upload goes to object storage rather than to Bunny, and
// the transfer that puts it in front of the encoder is a server-to-server move
// over Cloudflare's own network (worker/video-ingest) with an idempotent retry.
// So a dropped connection costs the creator the bytes in flight at that moment,
// and never a second transcode.
//
// The failures carry every field the admin panel reads — code, reason, stage,
// byte counts and per-attempt timings — so one kind of record answers for every
// way an upload can die.
// =============================================================================

import {
  blameTheDeviceIfNothingMoved,
  UPLOAD_STALL_TIMEOUT_MS,
  probeDeviceRead,
  VideoUploadError,
  isRetryableUploadFailure,
  TRANSIENT_4XX,
  type UploadFailureReason,
} from "./upload-error";
import { describeUploadReachability, hostOf } from "./upload-diagnostics";

/**
 * One network verdict per host per page, reused by every later attempt.
 *
 * Measured against the alternative: probing on each of the four attempts of one
 * part would add four probe timeouts — up to a minute — to a failure the creator
 * is already waiting on, on the very connection that is failing. The FIRST
 * attempt pays for the answer and the rest carry it.
 */
const reachabilityVerdicts = new Map<string, string>();

async function describeUploadReachabilityOnce(url: string): Promise<string> {
  const host = hostOf(url) ?? url;
  const known = reachabilityVerdicts.get(host);
  if (known !== undefined) return known;

  const verdict = await describeUploadReachability(url);
  reachabilityVerdicts.set(host, verdict);
  return verdict;
}

/** Forget the verdicts. Exported for tests, which must not inherit a network
 *  answer from a test that ran before them — and that is not hypothetical: a
 *  suite whose first failure reached the real host made every later assertion
 *  read that stale sentence. */
export function resetUploadReachabilityCache(): void {
  reachabilityVerdicts.clear();
}

/**
 * How many times to send the WHOLE file, and how long to wait between tries.
 *
 * Short by construction: every retry re-sends everything that already went, on
 * the creator's data plan. Three attempts is enough to ride out a reset or a
 * moment of no signal, and small enough that a link which genuinely cannot carry
 * the file stops instead of spending a gigabyte discovering it cannot.
 */
export const PUT_RETRY_DELAYS = [0, 3_000, 10_000] as const;

export interface PutUploadTarget {
  /** Where the bytes go, authorization included in the query string. */
  url: string;
  /**
   * Unix seconds, when the bucket will start refusing this URL.
   *
   * Carried for the one error worth naming separately: a 403 part-way through a
   * slow upload on a phone is a signature that expired, not a bad file, and a
   * creator who is told that knows to retry rather than to re-record.
   */
  expiresAt?: number;
}

export interface PutResult {
  /**
   * The object's ETag, when the bucket exposed one.
   *
   * A whole-object PUT ignores this. A PART cannot: `CompleteMultipartUpload`
   * names every part by its ETag, so a part whose ETag the browser could not read
   * is a part that can never be declared — which is why the bucket's CORS policy
   * has to list the header as exposed. Measured on the live bucket: it does
   * (`ExposeHeader: ETag`), and the multipart transport depends on it, so a
   * bucket without it fails at completion rather than at the first part.
   */
  etag: string | null;
}

export interface PutUploadOptions {
  /** Bytes acknowledged so far, out of the file's size. Never walks backwards. */
  onProgress?: (uploaded: number, total: number) => void;
  /** Between attempts, so the screen can say why it is waiting. */
  onRetry?: (info: {
    attempt: number;
    totalAttempts: number;
    offset: number;
    reason?: UploadFailureReason;
  }) => void;
  signal?: AbortSignal;
}

/** The browser's own view of whether there is a connection. */
function offlineNow(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * What a non-2xx answer means.
 *
 * One classification, read by everything that reports an upload failure: if a
 * status meant one thing here and another somewhere else, the admin panel would
 * start telling two stories about one provider.
 */
function describePutStatus(status: number, body: string): VideoUploadError {
  const detail = body ? `: ${body.slice(0, 160)}` : "";

  // A 403 is the bucket refusing the signature rather than the file, and it has
  // exactly one cause worth naming: the presigned URL expired while a slow phone
  // connection was still sending. Retrying the same URL cannot work, so this is
  // not retryable — the page asks for a fresh target instead.
  if (status === 403) {
    return new VideoUploadError(
      "REJECTED",
      "This upload took longer than its permission allowed. Press retry: it will reserve a new one and send the file again.",
      status,
      { stage: "put", reason: "provider" }
    );
  }

  // 413 no longer comes from us — nothing we run receives the body — so it can
  // only be the bucket's own ceiling, which is 5 GiB, well above what the
  // application accepts. Say which side refused it rather than blaming the
  // connection for a refusal that arrived in milliseconds.
  if (status === 413) {
    return new VideoUploadError(
      "UNSUPPORTED",
      "The storage service refused a file this large.",
      status,
      { stage: "put", reason: "provider" }
    );
  }

  if (status >= 400 && status < 500 && !TRANSIENT_4XX.has(status)) {
    return new VideoUploadError(
      "REJECTED",
      `The upload server rejected the file (HTTP ${status})${detail}`,
      status,
      { stage: "put", reason: "provider", providerBody: body.slice(0, 600) }
    );
  }

  return new VideoUploadError(
    "NETWORK",
    `The storage service answered HTTP ${status}${detail}`,
    status,
    { stage: "put", reason: "provider", providerBody: body.slice(0, 600) }
  );
}

/**
 * Send one blob to one presigned URL. Resolves when the bucket has all of it.
 *
 * Takes a Blob rather than a File, and is exported, so the multipart transport
 * (lib/upload-multipart.ts) sends a PART through this same function instead of
 * growing a second XHR with its own watchdog. Two copies of "abandon a request
 * that has stopped moving" is how one transport ends up patient and the other
 * impatient, and this application has already paid for that once.
 *
 * The watchdog: bytes moving means the request is left alone for as long as it
 * takes, and a request with NO bytes moving for the window is aborted and
 * retried. Without it a PUT that the network silently stopped delivering would
 * hang until the browser's own (unhelpfully generous) timeout, with a bar that
 * never moves.
 */
export function putBlob(
  source: Blob,
  target: PutUploadTarget,
  options: PutUploadOptions
): Promise<PutResult> {
  const { onProgress, signal } = options;

  return new Promise<PutResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const stopWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = undefined;
    };
    const armWatchdog = () => {
      stopWatchdog();
      watchdog = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_TIMEOUT_MS);
    };
    const finish = (error?: VideoUploadError) => {
      if (settled) return;
      settled = true;
      stopWatchdog();
      signal?.removeEventListener("abort", onCancel);
      if (error) reject(error);
      else resolve({ etag: xhr.getResponseHeader("ETag") });
    };

    xhr.open("PUT", target.url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      onProgress?.(Math.min(event.loaded, source.size), source.size);
      armWatchdog();
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return finish();
      finish(describePutStatus(xhr.status, xhr.responseText || ""));
    };

    // A phone that has lost its radio and one whose request was refused by the
    // storage service arrive here identically; only the browser knows which, and
    // it says so in `onLine`. When it says nothing — the dangerous case, because
    // `status: 0` also covers a refused preflight, a filtered host and a CORS
    // refusal — the device is ASKED, once per host per upload, and the answer
    // goes into the record. See lib/upload-diagnostics.ts for why an unreachable
    // host and a refused request can be told apart at all.
    xhr.onerror = () => {
      if (offlineNow()) {
        finish(
          new VideoUploadError(
            "NETWORK",
            "Your device went offline during the upload. Reconnect and retry.",
            undefined,
            { stage: "put", reason: "offline" }
          )
        );
        return;
      }

      void describeUploadReachabilityOnce(target.url)
        .then((verdict) =>
          finish(
            new VideoUploadError(
              "NETWORK",
              verdict ? `The connection dropped during upload. ${verdict}` : "The connection dropped during upload.",
              undefined,
              { stage: "put", reason: "reset", providerBody: verdict || undefined }
            )
          )
        )
        .catch(() =>
          finish(
            new VideoUploadError("NETWORK", "The connection dropped during upload.", undefined, {
              stage: "put",
              reason: "reset",
            })
          )
        );
    };

    xhr.ontimeout = () =>
      finish(
        new VideoUploadError("NETWORK", "The upload stalled and was retried.", undefined, {
          stage: "put",
          reason: "timeout",
        })
      );

    xhr.onabort = () =>
      finish(
        stalled
          ? new VideoUploadError("NETWORK", "The upload stalled and was retried.", undefined, {
              stage: "put",
              reason: "stall",
            })
          : new VideoUploadError("ABORTED", "Upload cancelled", undefined, {
              stage: "put",
              reason: "cancelled",
            })
      );

    const onCancel = () => {
      stalled = false;
      xhr.abort();
    };

    if (signal) {
      if (signal.aborted) {
        finish(
          new VideoUploadError("ABORTED", "Upload cancelled", undefined, {
            stage: "put",
            reason: "cancelled",
          })
        );
        return;
      }
      signal.addEventListener("abort", onCancel, { once: true });
    }

    // Armed before the first byte leaves, so a request that never gets going at
    // all — which produces no progress event to re-arm on — is still caught.
    armWatchdog();

    try {
      xhr.send(source);
    } catch (error) {
      // The device refusing the file, met where this transport actually meets
      // it: `send` hands the WHOLE file to the socket at once, so a pick the
      // browser cannot read throws from here rather than failing later on the
      // wire. The probe below is a hint, not a gate — the attempt is what
      // decides — so a file this browser can stream is sent, and the probe can
      // never be the reason a working file is refused.
      const name = error instanceof Error ? error.name : "UnknownError";
      finish(
        new VideoUploadError(
          "UNSUPPORTED",
          `This device would not let the page read that video (${name}). Choose it again — the Files ` +
            "app usually works where a photos or cloud app does not — or copy it onto the phone's own " +
            "storage first.",
          undefined,
          {
            stage: "put",
            reason: "preflight",
            providerBody:
              error instanceof Error && error.message
                ? `${name}: ${error.message}`.slice(0, 160)
                : name,
          }
        )
      );
    }
  });
}

/** Stamp how far the transfer got, so a report says more than the verdict. */
function withProgress(
  error: VideoUploadError,
  bytesSent: number,
  bytesTotal: number,
  stage: { offset?: number; retryCount?: number; attemptMs?: number[] }
): VideoUploadError {
  error.bytesSent = Math.max(0, Math.min(bytesSent, bytesTotal));
  error.bytesTotal = bytesTotal;
  if (stage.offset !== undefined) error.offset = stage.offset;
  if (stage.retryCount !== undefined) error.retryCount = stage.retryCount;
  if (stage.attemptMs?.length) error.attemptMs = [...stage.attemptMs];
  return error;
}

/**
 * Upload the whole file to the bucket, retrying the request a few times.
 *
 * Resolves once the bucket holds the file. Throws VideoUploadError on failure, with the
 * same fields every upload failure fills in — including the per-attempt timings,
 * which for a single request are the fastest way to tell "the host refused it in
 * twelve milliseconds" from "it was cut ninety seconds in".
 */
export async function uploadFileWithPut(
  file: File,
  target: PutUploadTarget,
  options: PutUploadOptions = {}
): Promise<void> {
  const { onProgress, onRetry, signal } = options;

  if (!file.size) {
    throw withProgress(
      new VideoUploadError("UNSUPPORTED", "That file is empty.", undefined, {
        stage: "put",
        reason: "preflight",
      }),
      0,
      0,
      {}
    );
  }

  // Two readings of whether this file can be handed over at all, and neither is
  // a gate: this one, and whatever the attempts themselves report. See
  // blameTheDeviceIfNothingMoved for when they are allowed to agree out loud.
  const refusal = await probeDeviceRead(file);

  let highest = 0;
  const report = (uploaded: number, total: number) => {
    // Progress is cumulative across attempts and never walks backwards: from the
    // creator's side a bar that restarts reads as the upload having started
    // over, which is exactly when they give up on it.
    highest = Math.max(highest, uploaded);
    onProgress?.(highest, total);
  };

  const attemptMs: number[] = [];
  let lastError: VideoUploadError | null = null;

  for (let attempt = 0; attempt < PUT_RETRY_DELAYS.length; attempt++) {
    if (PUT_RETRY_DELAYS[attempt] > 0) await sleep(PUT_RETRY_DELAYS[attempt], signal);

    const startedAt = Date.now();
    try {
      await putBlob(file, target, {
        onProgress: report,
        signal,
      });
      lastError = null;
      break;
    } catch (error) {
      const uploadError =
        error instanceof VideoUploadError
          ? error
          : new VideoUploadError("NETWORK", "Upload failed", undefined, {
              stage: "put",
              reason: "reset",
            });

      attemptMs.push(Date.now() - startedAt);

      if (!isRetryableUploadFailure(uploadError)) {
        throw withProgress(uploadError, highest, file.size, {
          offset: 0,
          retryCount: attempt,
          attemptMs,
        });
      }

      lastError = uploadError;
      onRetry?.({
        attempt: attempt + 1,
        totalAttempts: PUT_RETRY_DELAYS.length,
        offset: 0,
        reason: uploadError.reason,
      });
    }
  }

  if (lastError) {
    const where = { offset: 0, retryCount: PUT_RETRY_DELAYS.length - 1, attemptMs };
    // Stamped BEFORE the blame, and that order is the whole thing: the rule reads
    // the byte count to decide whether the device or the connection is at fault,
    // and an error that has not been told how far the transfer got cannot answer
    // it. In this transport the count lives outside the error until the ladder
    // ends, so it is the caller that has to hand it over.
    const stamped = withProgress(lastError, highest, file.size, where);
    throw withProgress(
      // The rule lives in lib/upload-error.ts: a device that refused to read the
      // file, on a transfer that moved nothing, is the answer — and anything that
      // DID move keeps the connection to blame.
      blameTheDeviceIfNothingMoved(stamped, refusal, "put"),
      highest,
      file.size,
      where
    );
  }

  report(file.size, file.size);
}
