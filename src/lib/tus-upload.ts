// =============================================================================
// GENHUB - TUS 1.0.0 direct upload to Bunny Stream
//
// Why this exists instead of a single PUT:
//
//   1. Bunny's management endpoint authenticates with the `AccessKey` header. A
//      browser PUT without it is a 401 (verified against the live API), and
//      shipping the key to clients would let anyone delete or replace every
//      video in the library. So the bytes do NOT go to the management API.
//   2. Bunny's TUS endpoint accepts a per-video presigned signature instead, so
//      the browser uploads directly to Bunny while the key stays on the server.
//   3. Uploads are chunked and recoverable. Genhub's audience is on mobile
//      networks: a 700 MB upload that dies at 90% must resume, not restart.
//
// The protocol surface used here is small and fixed by the TUS spec:
//   POST  endpoint  -> 201 + Location (reserve)
//   PATCH location  -> 204 + Upload-Offset (send a chunk)
//   HEAD  location  -> 200 + Upload-Offset (ask where to resume)
// =============================================================================

import type { BunnyUploadCredentials } from "./bunny";

// =============================================================================
// How big one PATCH is — the single most important upload setting on a phone
// =============================================================================
// TUS sends the file in parts, and a part that dies must be sent again from the
// offset the server confirms. So the chunk size is a bet on the connection:
//
//   * too big, and a single wobble discards minutes of transfer — a 32 MiB
//     chunk on a phone at 1 Mbit/s is four and a half minutes of work thrown
//     away by one lost signal, which is what "it reaches 80% and starts again"
//     looks like from the creator's side;
//   * too small, and the per-request overhead (and the chance of a stall
//     between requests) adds up.
//
// The old fixed 32 MiB was tuned for a desktop on a stable line. A phone gets
// five, and the size then follows the connection's own measured speed, so a
// fast one climbs back to 32 MiB after the first chunk proves it. Every value
// is a multiple of 256 KiB, which the TUS spec requires.

export const TUS_CHUNK_ALIGNMENT = 256 * 1024;
/** What a phone starts with: cheap to lose, quick to show progress. */
export const MOBILE_CHUNK_SIZE = 5 * 1024 * 1024;
/** What a desktop starts with. */
export const DESKTOP_CHUNK_SIZE = 16 * 1024 * 1024;
/** What a proven-fast connection is allowed to climb to. */
export const FAST_CHUNK_SIZE = 32 * 1024 * 1024;

/**
 * Chunk size to START with, before anything is known about the connection.
 *
 * Pure and exported so the rule is testable without a browser: the caller says
 * whether it looks like a phone, and this decides. A file no bigger than the
 * chunk is sent in one piece, which is the fastest and safest case there is.
 */
export function initialChunkSize(isMobile: boolean, fileSize: number): number {
  const preferred = isMobile ? MOBILE_CHUNK_SIZE : DESKTOP_CHUNK_SIZE;
  return Math.min(preferred, Math.max(TUS_CHUNK_ALIGNMENT, fileSize));
}

/**
 * Chunk size for the NEXT chunk, given how fast the last one actually went.
 *
 * Measured, not guessed: a creator on fibre and a creator on a 3G phone start
 * the same way and stop being the same after one chunk. Below 400 KB/s the
 * answer is always the smallest chunk (losing five megabytes hurts less than
 * losing thirty-two); above 2 MB/s the largest, because on a fast link the
 * per-request overhead is the cost that matters. In between, no change: a size
 * that is working is not worth re-deciding every chunk.
 *
 * Returns one of the three sizes above — every one a multiple of 256 KiB — or
 * the current size unchanged when the measurement says nothing useful.
 */
export function adaptChunkSize(current: number, bytesPerSecond: number): number {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return current;
  if (bytesPerSecond < 400 * 1024) return MOBILE_CHUNK_SIZE;
  if (bytesPerSecond > 2 * 1024 * 1024) return FAST_CHUNK_SIZE;
  return current;
}

/**
 * Does this look like a phone or tablet?
 *
 * `navigator.userAgentData.mobile` is the honest answer where a browser offers
 * it; the user-agent string is the fallback, which is why the pattern is loose
 * (it only has to be right often enough to pick a starting chunk size — the
 * measurement above corrects it immediately either way).
 *
 * SSR-safe: this runs in the browser during an upload, and returns false when
 * there is no navigator at all.
 */
export function looksLikeMobile(): boolean {
  if (typeof navigator === "undefined") return false;

  const hints = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof hints.userAgentData?.mobile === "boolean") return hints.userAgentData.mobile;

  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone|Opera Mini|IEMobile/i.test(
    navigator.userAgent || ""
  );
}

/**
 * Backoff between attempts at the SAME chunk, in ms.
 *
 * Six attempts, up to 30s apart. The audience is on mobile data: a signal that
 * dips for twenty seconds in a lift is ordinary, and giving up after ~12s (the
 * old four-attempt ladder) is what made a creator re-upload a whole file — and
 * reserve a second slot while the first sat orphaned in the library. The retry
 * is cheap because the resume asks the server for its offset first.
 */
const RETRY_DELAYS = [0, 1_000, 3_000, 8_000, 15_000, 30_000];

/**
 * How long one chunk may sit with no progress before it is treated as a dropped
 * connection and retried.
 *
 * Deliberately generous: a chunk on a slow phone connection is minutes, so this
 * is a stall detector, not a throughput limit. Without it a connection that
 * dies without an error event (a lost radio, a silent NAT timeout) leaves the
 * upload hanging forever with the progress bar frozen.
 *
 * Shortened from ten minutes, which was set when every chunk was 32 MiB. Now
 * that a phone sends 5 MiB at a time, ten minutes of silence cannot be a slow
 * transfer — it is a dead one, and the retry ladder should start while the
 * creator is still looking at the screen. Ten minutes of a frozen bar is what
 * makes somebody close the tab and give up on an upload that would have
 * finished. A genuinely slow link is still covered: this is time with ZERO
 * bytes moved, and the page warns the creator long before it fires (see
 * UPLOAD_STALL_WARNING_MS).
 *
 * THAT SENTENCE WAS ASPIRATION UNTIL RECENTLY. The value used to be assigned to
 * `xhr.timeout`, which is a cap on the WHOLE request — a throughput limit wearing
 * a stall detector's name. On a link slow enough that a 16 MiB chunk needs more
 * than three minutes of healthy transfer, the old code failed a connection that
 * was working perfectly, retried the same chunk from the same offset, and gave up
 * after six attempts: an upload that could never succeed no matter how long the
 * creator waited. Measured on a real link, a 4 MiB chunk took 5.7s, so the margin
 * is not theoretical. It is now enforced by a watchdog in sendChunk that every
 * progress event re-arms, which is what the paragraph above has always described.
 */
export const CHUNK_STALL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long the form waits, with no bytes moving, before telling the creator so.
 *
 * Reporting only — it never cancels anything. A phone that has switched apps,
 * locked its screen or lost signal looks exactly like a slow one from here, and
 * the creator can only act on the difference (come back to the page, move to
 * better signal) if we say something.
 */
export const UPLOAD_STALL_WARNING_MS = 45 * 1000;

/**
 * The largest video a creator may send, matching the "Max 2GB" label on the
 * upload form. Bunny Stream accepts far more, but every GB a mobile creator
 * pushes is time on a metered connection, and a file past this size almost
 * always means the wrong file was chosen (a raw camera export, a folder of
 * clips) rather than a scene someone meant to upload.
 *
 * Checked BEFORE the slot is reserved, so a file that is too large never
 * creates a Bunny object — see videoSizeError and the call sites.
 */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * A creator-facing message when a file is over the limit, or null when it is
 * fine. Shared so the form can refuse the file early (no wasted Bunny slot) and
 * `uploadFileWithTus` can refuse it again as a last line of defence.
 */
export function videoSizeError(file: File): string | null {
  if (file.size <= MAX_VIDEO_BYTES) return null;
  const gb = file.size / (1024 * 1024 * 1024);
  return `That video is ${gb.toFixed(2)} GB — the limit is 2 GB. Trim or compress it and try again.`;
}

export type TusErrorCode =
  | "NOT_CONFIGURED"
  | "EXPIRED"
  | "REJECTED"
  | "NETWORK"
  | "ABORTED"
  | "UNSUPPORTED";

export class TusUploadError extends Error {
  code: TusErrorCode;
  status?: number;
  /**
   * Which request died, when the failure came off the wire rather than from one
   * of the pre-flight checks above. Reported to the server so the failure leaves
   * a record — see lib/services/upload-failure.service.ts.
   */
  stage?: "reserve" | "chunk";
  /**
   * Bunny's response body, verbatim.
   *
   * Its own field rather than only text inside the message, because the two are
   * written for different readers: the message is a sentence for the creator,
   * clipped for a toast, while this is the line that NAMES the cause —
   * "Library ID missing or invalid.", "File size too large." — and it is what
   * makes a report actionable without reproducing the upload.
   */
  providerBody?: string;

  /**
   * How far the transfer had got when it died: the last figure the browser
   * reported through its upload-progress event.
   *
   * This is the fact that separates the two failures that are otherwise
   * identical in a report — a transfer that was moving (tens of megabytes, and
   * no HTTP status) from one that never got going (a bare zero, and the same
   * absent status). Both are NETWORK, both have a null status, and nothing else
   * in the report tells them apart.
   *
   * The limit of the number is worth knowing: it is what was REPORTED, not what
   * was on the wire. A browser coalesces progress events, so a connection that
   * dies in its first moments reports zero, and zero is therefore "never
   * acknowledged", not "nothing was sent".
   */
  bytesSent?: number;
  /** The size of the file being sent, so `bytesSent` reads as a fraction of it. */
  bytesTotal?: number;

  constructor(
    code: TusErrorCode,
    message: string,
    status?: number,
    extra?: { stage?: "reserve" | "chunk"; providerBody?: string }
  ) {
    super(message);
    this.name = "TusUploadError";
    this.code = code;
    this.status = status;
    this.stage = extra?.stage;
    this.providerBody = extra?.providerBody;
  }
}

/** UTF-8 safe base64 — titles can contain characters btoa() refuses. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** `key base64value,key base64value` — the format TUS Upload-Metadata expects. */
export function encodeUploadMetadata(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key} ${base64(value)}`)
    .join(",");
}

/**
 * Bunny requires these on EVERY request to the TUS endpoint, not just the reserve
 * call. A plain TUS client that sends the Location alone gets
 * `400 Library ID missing or invalid.` on the first PATCH — which is exactly
 * what happened when this was wired up, so they are attached centrally here.
 */
function authHeaders(credentials: BunnyUploadCredentials): Record<string, string> {
  return {
    AuthorizationSignature: credentials.signature,
    AuthorizationExpire: String(credentials.expirationTime),
    LibraryId: credentials.libraryId,
    VideoId: credentials.videoId,
  };
}

/**
 * Turn a Bunny/socket failure into something a creator can act on. The 401 case
 * is called out by name because Bunny's own docs list an expired authorization
 * as the most common cause, and "Upload failed" sends people hunting for the
 * wrong problem.
 */
function describe(
  status: number,
  body: string,
  stage: "reserve" | "chunk"
): TusUploadError {
  // Kept whole (clipped only at 500) while the message below clips at 160: the
  // report is read by whoever is diagnosing, and a truncated JSON body is often
  // missing the one field that explains it.
  const providerBody = body ? body.slice(0, 500) : undefined;

  if (status === 401 || status === 403) {
    return new TusUploadError(
      "REJECTED",
      "Bunny rejected the upload authorization (it may have expired). Please retry the upload.",
      status,
      { stage, providerBody }
    );
  }
  if (status === 413) {
    return new TusUploadError(
      "UNSUPPORTED",
      "Bunny refused the file as too large for this plan.",
      status,
      { stage, providerBody }
    );
  }
  return new TusUploadError(
    "NETWORK",
    `Upload failed (HTTP ${status})${body ? `: ${body.slice(0, 160)}` : ""}`,
    status,
    { stage, providerBody }
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TusUploadError("ABORTED", "Upload cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reserve the upload and return the URL the chunks are PATCHed to. */
async function createUpload(
  file: File,
  credentials: BunnyUploadCredentials
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(credentials.endpoint, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(file.size),
        "Upload-Metadata": encodeUploadMetadata({
          filetype: file.type || "video/mp4",
          title: file.name || "Untitled video",
        }),
        ...authHeaders(credentials),
      },
    });
  } catch {
    throw new TusUploadError(
      "NETWORK",
      "Could not reach the upload server. Check your connection and retry.",
      undefined,
      { stage: "reserve" }
    );
  }

  if (res.status !== 201 && !res.ok) {
    throw describe(res.status, await res.text().catch(() => ""), "reserve");
  }

  const location = res.headers.get("Location");
  if (!location) {
    throw new TusUploadError(
      "UNSUPPORTED",
      "Upload server did not return a location to upload to.",
      undefined,
      { stage: "reserve" }
    );
  }
  // Bunny may answer with an absolute URL or a path; both must resolve.
  return new URL(location, credentials.endpoint).toString();
}

/** Ask the server how many bytes it already holds, so a retry resumes. */
async function remoteOffset(
  location: string,
  credentials: BunnyUploadCredentials
): Promise<number | null> {
  try {
    const res = await fetch(location, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", ...authHeaders(credentials) },
    });
    if (!res.ok) return null;
    const offset = res.headers.get("Upload-Offset");
    return offset === null ? null : Number(offset);
  } catch {
    return null;
  }
}

/** One PATCH of one chunk, with progress. Resolves with the new server offset. */
function sendChunk(
  location: string,
  blob: Blob,
  offset: number,
  credentials: BunnyUploadCredentials,
  onLoaded: (loadedInChunk: number) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", location);
    xhr.setRequestHeader("Tus-Resumable", "1.0.0");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Content-Type", "application/offset+octet-stream");
    for (const [name, value] of Object.entries(authHeaders(credentials))) {
      xhr.setRequestHeader(name, value);
    }

    // -----------------------------------------------------------------------
    // The stall watchdog — deliberately NOT `xhr.timeout`
    // -----------------------------------------------------------------------
    // `xhr.timeout` bounds the WHOLE request, so on a slow link it fails an
    // upload that is working: 16 MiB at 100 KB/s is nearly three minutes, and the
    // retry then restarts the same chunk from the same offset until the ladder is
    // spent. What has to be detected is SILENCE, so the clock is re-armed by
    // every progress event. Bytes moving means the chunk is left alone for as
    // long as it takes; a connection that stops moving for
    // CHUNK_STALL_TIMEOUT_MS is abandoned and retried. See the constant's note.
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const stopWatchdog = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const armWatchdog = () => {
      stopWatchdog();
      watchdog = setTimeout(() => {
        // Set before the abort so `onabort` can tell this apart from a creator
        // pressing cancel: both arrive on the same event, and only one of them
        // is a retryable failure.
        stalled = true;
        xhr.abort();
      }, CHUNK_STALL_TIMEOUT_MS);
    };

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      armWatchdog();
      onLoaded(event.loaded);
    };

    // Every path that settles the promise stops the clock first: a watchdog that
    // fires after the fact would abort a request nobody is waiting on.
    xhr.onload = () => {
      stopWatchdog();
      if (xhr.status >= 200 && xhr.status < 300) {
        const next = xhr.getResponseHeader("Upload-Offset");
        resolve(next === null ? offset + blob.size : Number(next));
        return;
      }
      reject(describe(xhr.status, xhr.responseText || "", "chunk"));
    };
    // Every failure below is stamped `chunk`: it is the request that died, and
    // without it a report says only "NETWORK" — the same words the reserve POST
    // produces — so the reader cannot tell a slot that was never reserved from a
    // transfer that was already moving. The HTTP-status path gets it from
    // `describe()`; these three are the ones where nothing answered at all.
    xhr.onerror = () => {
      stopWatchdog();
      reject(
        new TusUploadError(
          "NETWORK",
          "The connection dropped during upload.",
          undefined,
          { stage: "chunk" }
        )
      );
    };
    // Kept although nothing sets `xhr.timeout` any more: it costs nothing, and a
    // browser or proxy that imposes its own cap lands on the same verdict as our
    // watchdog rather than on an unhandled event.
    xhr.ontimeout = () => {
      stopWatchdog();
      reject(
        new TusUploadError(
          "NETWORK",
          "The upload stalled and was retried.",
          undefined,
          { stage: "chunk" }
        )
      );
    };
    xhr.onabort = () => {
      stopWatchdog();
      reject(
        stalled
          ? new TusUploadError(
              "NETWORK",
              "The upload stalled and was retried.",
              undefined,
              { stage: "chunk" }
            )
          : new TusUploadError("ABORTED", "Upload cancelled", undefined, { stage: "chunk" })
      );
    };

    if (signal) {
      if (signal.aborted) {
        stopWatchdog();
        reject(
          new TusUploadError("ABORTED", "Upload cancelled", undefined, { stage: "chunk" })
        );
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    // Armed before the first byte leaves, so a request that never gets going at
    // all is still caught — that case produces no progress event to re-arm on.
    armWatchdog();
    xhr.send(blob);
  });
}

export interface TusUploadOptions {
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Fixes the chunk size and switches off the adaptation below. Overridable for
   * tests; must be a multiple of 256 KiB per the TUS spec.
   */
  chunkSize?: number;
}

/**
 * Stamp a failure with how far it got, and how big the file is.
 *
 * One function rather than the same two assignments at each `throw`, because a
 * report that only SOMETIMES carries a byte count is worse than one that never
 * does: its absence would stop meaning anything.
 *
 * The count is what the browser last REPORTED, never a claim about the wire —
 * see bytesSent on TusUploadError.
 */
function withProgress(
  error: TusUploadError,
  bytesSent: number,
  bytesTotal: number
): TusUploadError {
  error.bytesSent = Math.max(0, Math.min(bytesSent, bytesTotal));
  error.bytesTotal = bytesTotal;
  return error;
}

/**
 * Stream `file` into the reserved Bunny slot.
 *
 * Resolves once the last byte is stored. Throws TusUploadError on failure — the
 * caller decides whether to keep the reserved video id or discard it.
 */
export async function uploadFileWithTus(
  file: File,
  credentials: BunnyUploadCredentials,
  options: TusUploadOptions = {}
): Promise<void> {
  const { onProgress, signal } = options;

  if (!file.size) {
    throw withProgress(
      new TusUploadError("UNSUPPORTED", "That file is empty."),
      0,
      0
    );
  }
  // Refused here as well as in the form: a caller that skips the early check
  // (the edit-trailer path, a future one) must not be able to push an unbounded
  // file at Bunny on the creator's data plan.
  const sizeError = videoSizeError(file);
  if (sizeError) {
    throw withProgress(new TusUploadError("UNSUPPORTED", sizeError), 0, file.size);
  }
  // Catch an expired authorization here rather than as an opaque 401 mid-upload.
  if (credentials.expirationTime <= Math.floor(Date.now() / 1000)) {
    throw withProgress(
      new TusUploadError(
        "EXPIRED",
        "The upload authorization expired before the upload started. Please retry."
      ),
      0,
      file.size
    );
  }

  // The reserve call is stamped here rather than at each of its own throws: it
  // is the one failure that can happen before a single byte is offered, so
  // "zero of N" is the honest reading, and a report that carried the byte count
  // only sometimes would make its absence meaningless.
  let location: string;
  try {
    location = await createUpload(file, credentials);
  } catch (error) {
    throw error instanceof TusUploadError ? withProgress(error, 0, file.size) : error;
  }
  let offset = 0;

  // A caller-supplied size wins (tests pin it); otherwise start from what the
  // device looks like and let the measurements below take over.
  const fixedChunkSize = options.chunkSize;
  let chunkSize = fixedChunkSize ?? initialChunkSize(looksLikeMobile(), file.size);

  while (offset < file.size) {
    const blob = file.slice(offset, offset + chunkSize);
    const chunkStart = offset;
    let lastError: TusUploadError | null = null;
    // When the successful attempt started, to measure this chunk's real speed.
    // Not the time the whole chunk took: retries and their backoff sleeps are
    // the connection failing, not the connection's speed.
    let attemptStartedAt = 0;
    // How much of THIS chunk the dying attempt had handed to the socket. Zero
    // means nothing left the browser — a request that was never sent, which is a
    // different fault from one that was (see bytesSent on TusUploadError).
    let attemptSent = 0;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) await sleep(RETRY_DELAYS[attempt], signal);
      attemptSent = 0;
      try {
        attemptStartedAt = Date.now();
        offset = await sendChunk(
          location,
          blob,
          chunkStart,
          credentials,
          (loaded) => {
            attemptSent = loaded;
            onProgress?.(chunkStart + loaded, file.size);
          },
          signal
        );
        lastError = null;
        break;
      } catch (error) {
        const tusError =
          error instanceof TusUploadError
            ? error
            : new TusUploadError("NETWORK", "Upload failed");

        // Cancelled or refused outright: retrying cannot help.
        if (tusError.code === "ABORTED" || tusError.code === "UNSUPPORTED") {
          throw withProgress(tusError, chunkStart + attemptSent, file.size);
        }
        // An expired signature fails identically forever.
        if (tusError.status === 401 || tusError.status === 403) {
          throw withProgress(tusError, chunkStart + attemptSent, file.size);
        }

        lastError = tusError;

        // The server may already hold part of this chunk — ask before resending
        // from the old offset, otherwise the chunk is written twice.
        const serverOffset = await remoteOffset(location, credentials);
        if (serverOffset !== null && serverOffset > chunkStart) {
          offset = serverOffset;
          lastError = null;
          break;
        }
      }
    }

    if (lastError) {
      throw withProgress(lastError, chunkStart + attemptSent, file.size);
    }
    onProgress?.(offset, file.size);

    // Decide the next chunk from what this one achieved — see adaptChunkSize.
    // Skipped when the caller pinned a size, so tests stay deterministic.
    if (fixedChunkSize === undefined) {
      const seconds = (Date.now() - attemptStartedAt) / 1000;
      const moved = offset - chunkStart;
      if (seconds > 0 && moved > 0) {
        chunkSize = adaptChunkSize(chunkSize, moved / seconds);
      }
    }
  }
}
