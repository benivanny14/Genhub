// =============================================================================
// GENHUB - Whole-file upload through the proxy (one PUT)
//
// The transport the creator asked for: one standard HTTP PUT, one progress bar,
// no chunk bookkeeping. The browser sends the file to a Worker that holds the
// Bunny library key and streams the body on (see worker/bunny-upload) — because
// the key manages every video in the library and cannot be handed to a client.
//
// WHAT THIS BUYS, HONESTLY. Fewer moving parts on the client, a bar that maps to
// one request, and no dependency on Bunny's resumable endpoint. What it COSTS is
// the property the TUS path was built for: there is no offset to resume from. A
// connection that dies at 90% of a 90 MB file has sent 81 MB that are now gone,
// so the retry ladder here is deliberately SHORT — three attempts, ten seconds
// apart, about a hundred megabytes of the creator's data at worst — instead of
// the two-and-a-half-minute ladder that is patient because patience is cheap
// when the bytes already on the server are kept.
//
// That trade is why the page only takes this path when the file fits in one
// request, and why the resumable path remains for everything else. Neither
// transport is the right answer to every file, and pretending otherwise is how
// the earlier version of this uploader ended up tuned for a desktop.
//
// The failures carry the same shape as the resumable path's — code, reason,
// stage, byte counts, per-attempt timings — so the admin panel reads one kind of
// record whichever way the bytes went.
// =============================================================================

import {
  CHUNK_STALL_TIMEOUT_MS,
  TusUploadError,
  isRetryableUploadFailure,
  TRANSIENT_4XX,
  type TusFailureReason,
} from "./tus-upload";

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
  /** The largest file this path accepts; larger files take the resumable path. */
  maxBytes: number;
}

export interface PutUploadOptions {
  /** Bytes acknowledged so far, out of the file's size. Never walks backwards. */
  onProgress?: (uploaded: number, total: number) => void;
  /** Between attempts, so the screen can say why it is waiting. */
  onRetry?: (info: {
    attempt: number;
    totalAttempts: number;
    offset: number;
    reason?: TusFailureReason;
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
 * Mirrors `describe()` in the resumable path on purpose: the same status has to
 * mean the same thing whichever transport produced it, or the admin panel starts
 * telling two stories about one provider.
 */
function describePutStatus(status: number, body: string): TusUploadError {
  const detail = body ? `: ${body.slice(0, 160)}` : "";

  // 413 is the proxy's own ceiling. The client is supposed to have checked the
  // size first, so reaching here means the two disagreed — say so plainly rather
  // than reporting it as a connection problem.
  if (status === 413) {
    return new TusUploadError(
      "UNSUPPORTED",
      "The upload server refused a file this large. Try again, and it will be sent in pieces.",
      status,
      { stage: "put", reason: "provider" }
    );
  }

  if (status >= 400 && status < 500 && !TRANSIENT_4XX.has(status)) {
    return new TusUploadError(
      "REJECTED",
      `The upload server rejected the file (HTTP ${status})${detail}`,
      status,
      { stage: "put", reason: "provider", providerBody: body.slice(0, 600) }
    );
  }

  return new TusUploadError(
    "NETWORK",
    `The upload server answered HTTP ${status}${detail}`,
    status,
    { stage: "put", reason: "provider", providerBody: body.slice(0, 600) }
  );
}

/**
 * Send the file once. Resolves when Bunny has the whole thing.
 *
 * The watchdog is the same rule as the chunked path's: bytes moving means the
 * request is left alone for as long as it takes, and a request with NO bytes
 * moving for the window is aborted and retried. Without it a PUT that the
 * network silently stopped delivering would hang until the browser's own
 * (unhelpfully generous) timeout, with a bar that never moves.
 */
function putOnce(
  file: File,
  target: PutUploadTarget,
  options: PutUploadOptions
): Promise<void> {
  const { onProgress, signal } = options;

  return new Promise<void>((resolve, reject) => {
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
      }, CHUNK_STALL_TIMEOUT_MS);
    };
    const finish = (error?: TusUploadError) => {
      if (settled) return;
      settled = true;
      stopWatchdog();
      signal?.removeEventListener("abort", onCancel);
      if (error) reject(error);
      else resolve();
    };

    xhr.open("PUT", target.url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      onProgress?.(Math.min(event.loaded, file.size), file.size);
      armWatchdog();
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return finish();
      finish(describePutStatus(xhr.status, xhr.responseText || ""));
    };

    // A phone that has lost its radio and one whose request was refused by a
    // proxy arrive here identically; only the browser knows which, and it says
    // so in `onLine`.
    xhr.onerror = () =>
      finish(
        offlineNow()
          ? new TusUploadError(
              "NETWORK",
              "Your device went offline during the upload. Reconnect and retry.",
              undefined,
              { stage: "put", reason: "offline" }
            )
          : new TusUploadError(
              "NETWORK",
              "The connection dropped during upload.",
              undefined,
              { stage: "put", reason: "reset" }
            )
      );

    xhr.ontimeout = () =>
      finish(
        new TusUploadError("NETWORK", "The upload stalled and was retried.", undefined, {
          stage: "put",
          reason: "timeout",
        })
      );

    xhr.onabort = () =>
      finish(
        stalled
          ? new TusUploadError("NETWORK", "The upload stalled and was retried.", undefined, {
              stage: "put",
              reason: "stall",
            })
          : new TusUploadError("ABORTED", "Upload cancelled", undefined, {
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
          new TusUploadError("ABORTED", "Upload cancelled", undefined, {
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
      xhr.send(file);
    } catch (error) {
      // The device refusing the file, met where this transport actually meets
      // it: `send` hands the WHOLE file to the socket at once, so a pick the
      // browser cannot read throws from here rather than failing later on the
      // wire. No probe decides it — the attempt does — which is the same rule
      // the resumable path now follows, so a file this browser can stream is
      // sent whichever transport carries it.
      const name = error instanceof Error ? error.name : "UnknownError";
      finish(
        new TusUploadError(
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
  error: TusUploadError,
  bytesSent: number,
  bytesTotal: number,
  stage: { offset?: number; retryCount?: number; attemptMs?: number[] }
): TusUploadError {
  error.bytesSent = Math.max(0, Math.min(bytesSent, bytesTotal));
  error.bytesTotal = bytesTotal;
  if (stage.offset !== undefined) error.offset = stage.offset;
  if (stage.retryCount !== undefined) error.retryCount = stage.retryCount;
  if (stage.attemptMs?.length) error.attemptMs = [...stage.attemptMs];
  return error;
}

/**
 * Upload the whole file through the proxy, retrying the request a few times.
 *
 * Resolves once Bunny holds the file. Throws TusUploadError on failure, with the
 * same fields the resumable path fills in — including the per-attempt timings,
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
      new TusUploadError("UNSUPPORTED", "That file is empty.", undefined, {
        stage: "put",
        reason: "preflight",
      }),
      0,
      0,
      {}
    );
  }

  // The caller is expected to have checked this and taken the other path. Kept
  // as a last line of defence so a caller that skips it cannot push a file the
  // proxy will refuse — and so the refusal is a sentence about the file rather
  // than a bare 413 from someone else's server.
  if (file.size > target.maxBytes) {
    throw withProgress(
      new TusUploadError(
        "UNSUPPORTED",
        "That video is too large to send in one request.",
        undefined,
        { stage: "put", reason: "preflight" }
      ),
      0,
      file.size,
      {}
    );
  }

  let highest = 0;
  const report = (uploaded: number, total: number) => {
    // Progress is cumulative across attempts and never walks backwards: from the
    // creator's side a bar that restarts reads as the upload having started
    // over, which is exactly when they give up on it.
    highest = Math.max(highest, uploaded);
    onProgress?.(highest, total);
  };

  const attemptMs: number[] = [];
  let lastError: TusUploadError | null = null;

  for (let attempt = 0; attempt < PUT_RETRY_DELAYS.length; attempt++) {
    if (PUT_RETRY_DELAYS[attempt] > 0) await sleep(PUT_RETRY_DELAYS[attempt], signal);

    const startedAt = Date.now();
    try {
      await putOnce(file, target, {
        onProgress: report,
        signal,
      });
      lastError = null;
      break;
    } catch (error) {
      const uploadError =
        error instanceof TusUploadError
          ? error
          : new TusUploadError("NETWORK", "Upload failed", undefined, {
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
    throw withProgress(lastError, highest, file.size, {
      offset: 0,
      retryCount: PUT_RETRY_DELAYS.length - 1,
      attemptMs,
    });
  }

  report(file.size, file.size);
}
