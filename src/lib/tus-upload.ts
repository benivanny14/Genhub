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
/** What a desktop starts with; small enough to survive ordinary resets. */
export const DESKTOP_CHUNK_SIZE = 8 * 1024 * 1024;
/** What a proven-fast connection is allowed to climb to. */
export const FAST_CHUNK_SIZE = 16 * 1024 * 1024;

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
 * The tail is deliberately long, and that is measured rather than guessed. On
 * this deployment one creator's phone failed every upload across five hours, and
 * Bunny's own library confirms it never received a single byte: nine empty slots,
 * storage size zero. Four of those nine attempts could not even deliver the
 * failure report to our server, so the device was reachable enough for a
 * one-kilobyte POST and not for a three-megabyte PATCH — a connection that goes
 * away and comes back, not one that is gone.
 *
 * A ladder of [0, 1s, 3s, 8s] gives up twelve seconds after the first failure,
 * which cannot tell those two cases apart.
 *
 * The last two rungs were added after the resume path was driven against the
 * live API from a real device (Android emulator, the link cut in the middle of a
 * 48 MB upload). Two measurements came out of it, and both argue for patience
 * rather than a shorter ladder:
 *
 *   * the outage itself spends rungs quickly — 26 seconds offline used five of
 *     the six, so the first attempt that reached the server again was the last
 *     one left; and
 *   * Bunny keeps the upload session LOCKED for about a minute after the PATCH
 *     it lost, answering 423 until it lets go.
 *
 * Six attempts therefore ended a transfer that had a healthy connection, bytes
 * already on the server, and a quarter of the file still to send. Eight attempts
 * span ~2.7 minutes, which outlasts the lock instead of racing it, and a
 * genuinely dead connection is still reported — with the offset, the chunk and
 * the reason — well inside that.
 */
export const CHUNK_RETRY_DELAYS = [
  0,
  1_000,
  3_000,
  8_000,
  15_000,
  30_000,
  45_000,
  60_000,
] as const;
const RESERVE_RETRY_DELAYS = [0, 1_000, 3_000];

/**
 * How long one chunk may sit with no progress before it is treated as a dropped
 * connection and retried.
 *
 * Deliberately generous: a chunk on a slow phone connection is minutes, so this
 * is a stall detector, not a throughput limit. Without it a connection that
 * dies without an error event (a lost radio, a silent NAT timeout) leaves the
 * upload hanging forever with the progress bar frozen.
 *
 * This is deliberately a silence detector, not a total request timeout. A
 * genuinely slow link is allowed to finish while the browser keeps reporting
 * progress; a dead connection is retried after a reasonable pause.
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
export const CHUNK_STALL_TIMEOUT_MS = 90 * 1000;

/**
 * How long the form waits, with no bytes moving, before telling the creator so.
 *
 * Reporting only — it never cancels anything. A phone that has switched apps,
 * locked its screen or lost signal looks exactly like a slow one from here, and
 * the creator can only act on the difference (come back to the page, move to
 * better signal) if we say something.
 */
export const UPLOAD_STALL_WARNING_MS = 30 * 1000;

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
// PostgreSQL/Prisma stores uploadSizeBytes as a signed INTEGER. Keep the public
// limit one byte below INTEGER_MAX so a video that Bunny accepts cannot fail
// later during finalization with a database overflow.
export const MAX_VIDEO_BYTES = 2_147_483_647; // just under 2 GiB

/**
 * How much of the file the pre-flight read probe pulls.
 *
 * Small on purpose: this runs before every upload, including the ones that work,
 * and a phone cannot afford to read a gigabyte twice. It is enough to learn
 * whether the device will let a SCRIPT open the file at all — which is a hint
 * about the file and the provider holding it, never a verdict on whether the
 * transfer can send it. See the call site in uploadFileWithTus for why that
 * distinction cost a creator their uploads.
 */
const READ_PROBE_BYTES = 1024;

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

/**
 * WHY a transfer died, in one word.
 *
 * `code` says what the uploader decided (NETWORK, REJECTED); this says which
 * physical fact produced that verdict. They are not interchangeable: an offline
 * phone needs nothing from us but time, a reset connection wants a smaller
 * chunk, a stall usually means the tab was sent to the background, and a
 * provider error needs Bunny's own body read. Before this field every one of
 * them arrived as the same word — NETWORK, with a null status — and the reader
 * could not tell which fault they were looking at.
 */
export const TUS_FAILURE_REASONS = [
  "offline",
  "reset",
  "stall",
  "timeout",
  "provider",
  "cancelled",
  "preflight",
] as const;

export type TusFailureReason = (typeof TUS_FAILURE_REASONS)[number];

/**
 * True when the browser itself knows there is no connection.
 *
 * `navigator.onLine` is a hint, not the truth — it is false precisely when the
 * OS has no interface, which is the one case where telling the creator "you are
 * offline" is both correct and actionable. Anywhere else the honest report is
 * that the connection dropped, so this is only ever used to add detail to a
 * failure that has already happened.
 */
function offlineNow(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export class TusUploadError extends Error {
  code: TusErrorCode;
  status?: number;
  /**
   * Which request died, when the failure came off the wire rather than from one
   * of the pre-flight checks above. Reported to the server so the failure leaves
   * a record — see lib/services/upload-failure.service.ts.
   */
  stage?: "reserve" | "chunk" | "put";
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

  /**
   * Where the transfer died: the offset the failing chunk started at, as the
   * server last confirmed it.
   *
   * This is the number a retry resumes from, and it is the one fact that
   * survives independently of the browser's own (coalesced) progress events —
   * so "died at 96 MB" here is a server-confirmed floor, while `bytesSent` is a
   * client-reported estimate.
   */
  offset?: number;
  /** Which chunk this was, counting from zero. */
  chunkIndex?: number;
  /**
   * How many retries at THIS chunk preceded the one that died. Zero means the
   * first attempt failed; three (with the current ladder) means the connection
   * refused the same chunk four times, which is a different finding from a
   * single drop.
   */
  retryCount?: number;
  /**
   * How long each attempt at this chunk lasted, in milliseconds, oldest first.
   *
   * The one measurement that tells "a link too slow to finish the chunk" apart
   * from "a request that never got going". Six attempts that each ended in
   * twelve milliseconds cannot be a transfer; six attempts that each lasted
   * forty seconds are a transfer that keeps being cut, and the two need opposite
   * fixes — smaller chunks versus a network that cannot reach the host at all.
   * A count of retries alone says neither, because both spend the same ladder.
   *
   * The backoff sleeps between attempts are deliberately NOT in these numbers: a
   * wait we chose is not evidence about a connection.
   */
  attemptMs?: number[];
  /** Which physical fault this was — see TusFailureReason. */
  reason?: TusFailureReason;

  constructor(
    code: TusErrorCode,
    message: string,
    status?: number,
    extra?: {
      stage?: "reserve" | "chunk" | "put";
      providerBody?: string;
      reason?: TusFailureReason;
    }
  ) {
    super(message);
    this.name = "TusUploadError";
    this.code = code;
    this.status = status;
    this.stage = extra?.stage;
    this.providerBody = extra?.providerBody;
    this.reason = extra?.reason;
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
 * The 4xx answers that mean "send the same bytes again", as opposed to "this
 * request is wrong".
 *
 * Listed once because two places have to agree about it: `describe()` decides
 * whether a failure is NETWORK at all, and `isRetryable()` decides whether it
 * spends an attempt. When the two lists drifted apart, a status could be
 * classified transient and still not be retried, which reads as a broken ladder.
 *
 *   408 the server gave up reading the request
 *   409 the offset we sent does not match what it holds
 *   423 Locked — Bunny holds the upload session while the PATCH that the
 *       connection just lost is still running. Measured against the live API on
 *       a real device (Android emulator, network cut in the middle of a 60 MB
 *       upload): the first attempt that reaches the server after the link comes
 *       back is refused with exactly this. Read as permanent, it ended an upload
 *       that was a quarter sent, on a connection that was working again.
 *   429 too many requests
 */
export const TRANSIENT_4XX: ReadonlySet<number> = new Set([408, 409, 423, 429]);

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
      { stage, providerBody, reason: "provider" }
    );
  }
  if (status === 413) {
    return new TusUploadError(
      "UNSUPPORTED",
      "Bunny refused the file as too large for this plan.",
      status,
      { stage, providerBody, reason: "provider" }
    );
  }
  // A client-side 4xx outside TRANSIENT_4XX will not improve by sending the
  // same bytes again. Keeping it out of NETWORK also makes the admin panel
  // distinguish provider validation from a dropped connection.
  if (status >= 400 && status < 500 && !TRANSIENT_4XX.has(status)) {
    return new TusUploadError(
      "REJECTED",
      `Bunny rejected the upload (HTTP ${status})${body ? `: ${body.slice(0, 160)}` : ""}`,
      status,
      { stage, providerBody, reason: "provider" }
    );
  }
  return new TusUploadError(
    "NETWORK",
    `Upload failed (HTTP ${status})${body ? `: ${body.slice(0, 160)}` : ""}`,
    status,
    // A 408 answering a chunk the server was still reading is a request
    // timeout, not a dropped link: same retry, different diagnosis.
    { stage, providerBody, reason: status === 408 ? "timeout" : "provider" }
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
      reject(new TusUploadError("ABORTED", "Upload cancelled", undefined, { reason: "cancelled" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reserve the upload and return the URL the chunks are PATCHed to. */
async function createUpload(
  file: File,
  credentials: BunnyUploadCredentials,
  signal?: AbortSignal
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
      // The signal belongs to the REQUEST, not to the headers. It was added to
      // the object above, where TypeScript read it as a header named "signal"
      // and the browser sent nothing — so pressing Cancel left a reserve POST
      // in flight, and the slot it created was an orphan nobody had stopped.
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new TusUploadError("ABORTED", "Upload cancelled", undefined, {
        stage: "reserve",
        reason: "cancelled",
      });
    }
    // Distinguishing this from an ordinary reset is the difference between
    // "wait for signal" and "something is refusing the connection" — the two
    // look identical in every other field of the report.
    if (offlineNow()) {
      throw new TusUploadError(
        "NETWORK",
        "Your device is offline. Reconnect and retry — the upload resumes where it stopped.",
        undefined,
        { stage: "reserve", reason: "offline" }
      );
    }
    throw new TusUploadError(
      "NETWORK",
      "Could not reach the upload server. Check your connection and retry.",
      undefined,
      { stage: "reserve", reason: "reset" }
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

/** Recover a lost reserve response without creating another Bunny video slot. */
async function createUploadWithRetry(
  file: File,
  credentials: BunnyUploadCredentials,
  signal?: AbortSignal
): Promise<string> {
  let lastError: TusUploadError | null = null;

  for (let attempt = 0; attempt < RESERVE_RETRY_DELAYS.length; attempt++) {
    try {
      if (RESERVE_RETRY_DELAYS[attempt] > 0) {
        await sleep(RESERVE_RETRY_DELAYS[attempt], signal);
      }
      return await createUpload(file, credentials, signal);
    } catch (error) {
      const tusError =
        error instanceof TusUploadError
          ? error
          : new TusUploadError("NETWORK", "Could not reserve the upload target.", undefined, {
              stage: "reserve",
              reason: "reset",
            });

      // Stamped here rather than at the end: a refusal (401, an abort) leaves
      // the loop at this same point, and "which try died" is what makes the
      // difference between an expired key and a flapping network readable.
      tusError.retryCount = attempt;

      if (!isRetryableUploadFailure(tusError)) throw tusError;
      lastError = tusError;
    }
  }

  throw lastError ?? new TusUploadError("NETWORK", "Could not reserve the upload target.", undefined, {
    stage: "reserve",
  });
}

/** Ask the server how many bytes it already holds, so a retry resumes. */
async function remoteOffset(
  location: string,
  credentials: BunnyUploadCredentials,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const res = await fetch(location, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0", ...authHeaders(credentials) },
      signal,
    });
    if (!res.ok) return null;
    const offset = res.headers.get("Upload-Offset");
    if (offset === null) return null;
    const parsed = Number(offset);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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
        const parsed = next === null ? offset + blob.size : Number(next);
        if (
          !Number.isInteger(parsed) ||
          parsed < offset ||
          parsed > offset + blob.size
        ) {
          reject(
            new TusUploadError(
              "UNSUPPORTED",
              "The upload server returned an invalid upload offset.",
              undefined,
              { stage: "chunk", reason: "provider" }
            )
          );
          return;
        }
        resolve(parsed);
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
      // A phone that has lost its radio and one behind a proxy that reset the
      // socket arrive here identically. Only the browser knows which it is, and
      // it says so in `onLine`.
      reject(
        offlineNow()
          ? new TusUploadError(
              "NETWORK",
              "Your device went offline during the upload. Reconnect and retry — it resumes where it stopped.",
              undefined,
              { stage: "chunk", reason: "offline" }
            )
          : new TusUploadError(
              "NETWORK",
              "The connection dropped during upload.",
              undefined,
              { stage: "chunk", reason: "reset" }
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
          { stage: "chunk", reason: "timeout" }
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
              { stage: "chunk", reason: "stall" }
            )
          : new TusUploadError("ABORTED", "Upload cancelled", undefined, {
              stage: "chunk",
              reason: "cancelled",
            })
      );
    };

    if (signal) {
      if (signal.aborted) {
        stopWatchdog();
        reject(
          new TusUploadError("ABORTED", "Upload cancelled", undefined, {
            stage: "chunk",
            reason: "cancelled",
          })
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

export interface TusUploadRetryInfo {
  /** Which chunk is being retried, counting from zero. */
  chunkIndex: number;
  /** The retry that is about to happen: 1 for the second attempt at a chunk. */
  attempt: number;
  /** How many attempts this chunk is allowed in total. */
  totalAttempts: number;
  /** The offset the chunk is retried from — the server's own figure. */
  offset: number;
  /** The fault that spent the attempt, so the message can name it. */
  reason?: TusFailureReason;
}

/**
 * A creator-facing sentence for the retry that is about to happen.
 *
 * The form used to sit at the same percentage through a backoff, which reads as
 * a hang — the creator cannot tell "still working" from "dead". Naming the
 * fault is the point: "you are offline" and "the host refused that attempt"
 * lead to different actions (move to better signal, or stop and tell us), while
 * a silent bar leads to giving up on a file that was one chunk from done.
 *
 * Pure, so the wording is pinned by a test rather than by a screenshot.
 *
 * Takes only the three fields it reads, so both transports can hand it their own
 * retry info: the chunked path knows which chunk it is on and the whole-file PUT
 * does not, and neither fact changes the sentence a creator needs to read.
 */
export function describeRetry(
  info: Pick<TusUploadRetryInfo, "attempt" | "totalAttempts" | "reason">
): string {
  const attempt = `${info.attempt} of ${info.totalAttempts}`;
  switch (info.reason) {
    case "offline":
      return `You are offline — retrying (${attempt})`;
    case "reset":
      return `The connection dropped — retrying (${attempt})`;
    case "stall":
      return `No data moved for a while — retrying (${attempt})`;
    case "timeout":
      return `The upload timed out — retrying (${attempt})`;
    case "provider":
      return `The host refused that attempt — retrying (${attempt})`;
    default:
      return `Retrying (${attempt})`;
  }
}

export interface TusUploadOptions {
  onProgress?: (uploaded: number, total: number) => void;
  /**
   * Called between a failed attempt and the next one, so the form can say
   * "retrying" instead of leaving a frozen percentage on screen for the length
   * of the backoff. Reporting only — nothing here can change the upload.
   */
  onRetry?: (info: TusUploadRetryInfo) => void;
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
  bytesTotal: number,
  /**
   * Where the failure happened, when the caller knows. Every one of these is
   * optional so the pre-flight guards (which have no chunk and no offset) still
   * produce a report with an honest byte count and nothing invented.
   */
  where?: {
    offset?: number;
    chunkIndex?: number;
    retryCount?: number;
    attemptMs?: number[];
  }
): TusUploadError {
  error.bytesSent = Math.max(0, Math.min(bytesSent, bytesTotal));
  error.bytesTotal = bytesTotal;
  if (where?.offset !== undefined) error.offset = where.offset;
  if (where?.chunkIndex !== undefined) error.chunkIndex = where.chunkIndex;
  if (where?.retryCount !== undefined) error.retryCount = where.retryCount;
  // Copied rather than referenced: the caller keeps pushing onto its own array
  // for the attempts that follow, and a report that changed after the fact would
  // describe a different failure from the one it was written for.
  if (where?.attemptMs && where.attemptMs.length > 0) error.attemptMs = [...where.attemptMs];
  return error;
}

/**
 * Only transient transport/provider responses should consume a retry.
 *
 * The transient 4xx list is shared with `describe()` so a status cannot be
 * called transient in one place and permanent in the other — see TRANSIENT_4XX.
 *
 * Exported because a second transport now exists (the single PUT through the
 * upload proxy, lib/upload-put.ts) and it must answer this question the same
 * way. A retry policy that differs between two ways of sending the same file is
 * the same class of bug as the two transient lists that disagreed, one commit
 * before this one.
 */
export function isRetryableUploadFailure(error: TusUploadError): boolean {
  if (error.code !== "NETWORK") return false;
  if (error.status === undefined || error.status === null) return true;
  return TRANSIENT_4XX.has(error.status) || error.status >= 500;
}

/**
 * Stream `file` into the reserved Bunny slot.
 *
 * Resolves once the last byte is stored. Throws TusUploadError on failure — the
 * caller decides whether to keep the reserved video id or discard it.
 */
/**
 * What the device said when a scripted read of the picked file was refused.
 *
 * `name` is the browser's own error name — `NotReadableError` is the one that
 * means this — and `detail` keeps both parts for the record, because the name
 * alone will not explain a provider behaviour nobody has seen before.
 */
interface DeviceReadRefusal {
  name: string;
  detail: string;
}

/**
 * Read one kilobyte, and REPORT a refusal rather than acting on it.
 *
 * Still worth its cost on every upload, including the ones that work: it is the
 * only way to know that the file itself was the problem rather than the link.
 * What changed is who decides — see the comment at the call site and
 * blameTheDeviceIfNothingMoved below.
 */
async function readProbe(file: File): Promise<DeviceReadRefusal | null> {
  try {
    await file.slice(0, READ_PROBE_BYTES).arrayBuffer();
    return null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    return {
      name,
      detail:
        error instanceof Error && error.message ? `${name}: ${error.message}` : name,
    };
  }
}

/**
 * Name the DEVICE when the device is what refused the file, and only then.
 *
 * Two conditions, and both are needed:
 *
 *   * the scripted read was refused, AND
 *   * not one byte was acknowledged by the network.
 *
 * The second is what stops this from blaming the phone for a connection: an
 * attempt that acknowledged bytes proves the file WAS readable, so a failure
 * after that is the link and keeps saying so. And the first is what stops it
 * from blaming the phone for a link that died before anything could move: a
 * file this device never refused, on a transfer that never started, is the
 * connection as plainly as it ever was. Only together do they mean "this file, on
 * this device, cannot be handed over at all" — and that is a sentence the
 * creator can act on, which "the connection dropped" is not.
 *
 * Everything else about the failure is carried through: the chunk it died on,
 * the offset it died at, the ladder it spent and the timings, so the record in
 * the admin panel stays comparable with every other failure.
 */
function blameTheDeviceIfNothingMoved(
  error: TusUploadError,
  refusal: DeviceReadRefusal | null
): TusUploadError {
  if (!refusal) return error;
  if (error.stage !== "chunk") return error;
  if (error.bytesSent !== 0) return error;

  return withProgress(
    new TusUploadError(
      "UNSUPPORTED",
      `This device would not let the page read that video (${refusal.name}), and nothing ever left the ` +
        "browser. Choose it again — the Files app usually works where a photos or cloud app does not — " +
        "or copy it onto the phone's own storage first.",
      error.status,
      // Bunny never saw this one, so its own words are not what names the
      // cause — the DEVICE's are, and in the same field for the same reason.
      { stage: "chunk", reason: "preflight", providerBody: refusal.detail.slice(0, 160) }
    ),
    error.bytesSent ?? 0,
    error.bytesTotal ?? 0,
    {
      offset: error.offset,
      chunkIndex: error.chunkIndex,
      retryCount: error.retryCount,
      attemptMs: error.attemptMs,
    }
  );
}

export async function uploadFileWithTus(
  file: File,
  credentials: BunnyUploadCredentials,
  options: TusUploadOptions = {}
): Promise<void> {
  const { onProgress, onRetry, signal } = options;

  if (!file.size) {
    throw withProgress(
      new TusUploadError("UNSUPPORTED", "That file is empty.", undefined, {
        reason: "preflight",
      }),
      0,
      0
    );
  }
  // Refused here as well as in the form: a caller that skips the early check
  // (the edit-trailer path, a future one) must not be able to push an unbounded
  // file at Bunny on the creator's data plan.
  const sizeError = videoSizeError(file);
  if (sizeError) {
    throw withProgress(
      new TusUploadError("UNSUPPORTED", sizeError, undefined, { reason: "preflight" }),
      0,
      file.size
    );
  }
  // CAN THIS DEVICE ACTUALLY HAND US THE BYTES?
  //
  // A video picked on a phone is not a file on a disk: it arrives as a
  // `content://` URI owned by whichever app holds it, and Chrome reads it
  // lazily while the upload is running. When that read fails, the XHR raises a
  // plain error event with no status and no bytes — exactly what a refused
  // socket raises — so the transfer spends the whole ladder and then reports
  // "the connection dropped" for a fault that never touched the network. And
  // that is not hypothetical: a measured failure on a 4G link whose own rtt was
  // 150 ms recorded attempts of 35 ms and 45 ms, which no round trip can fit
  // inside.
  //
  // One kilobyte answers it, for the cost of one read. What it answers is a
  // HINT, not a verdict — and refusing the upload on it was the first version's
  // mistake: a video this device would not let a SCRIPT read was never offered
  // to the network at all, so a file that could have gone up reported instead
  // that it could not.
  //
  // The two reads are not the same operation, which is the part that got missed.
  // `file.slice(…).arrayBuffer()` asks the renderer to pull bytes into JavaScript
  // memory, and needs the provider to still be handing out a readable
  // descriptor. An XHR carrying the File asks the browser's NETWORK stack to
  // stream it, and there are providers where the second works and the first does
  // not: a cloud or photos provider offering only a one-shot stream, a file
  // handed over without seekable access. The emulator run (Chrome 113, a 6 MB
  // file from the system picker's Downloads folder) showed both reads succeeding
  // — which is exactly why it could not see the difference. It never met a
  // provider that refuses.
  //
  // So the refusal is CARRIED rather than acted on: the upload is attempted
  // anyway, and only a transfer that ends having moved nothing — no byte
  // acknowledged, on a file this device had already refused to read — is
  // reported as the device's fault (blameTheDeviceIfNothingMoved). A picked
  // video therefore goes up from wherever it lives on the device, and when it
  // genuinely cannot, the report says which of the two it was.
  const deviceRefusal = await readProbe(file);

  // Catch an expired authorization here rather than as an opaque 401 mid-upload.
  if (credentials.expirationTime <= Math.floor(Date.now() / 1000)) {
    throw withProgress(
      new TusUploadError(
        "EXPIRED",
        "The upload authorization expired before the upload started. Please retry.",
        undefined,
        { reason: "preflight" }
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
    location = await createUploadWithRetry(file, credentials, signal);
  } catch (error) {
    // No chunk was ever offered, so the offset is a true zero rather than an
    // unknown — and `offset: 0` is what makes that visible beside bytesSent.
    throw error instanceof TusUploadError
      ? withProgress(error, 0, file.size, { offset: 0 })
      : error;
  }
  let offset = 0;
  let reportedOffset = 0;
  /** Which chunk is in flight, counting from zero. Carried into the report. */
  let chunkIndex = 0;
  const reportProgress = (candidate: number) => {
    // A retry can emit a smaller per-request `loaded` value than the failed
    // attempt. The UI must never visibly move backwards while the server
    // offset is being reconciled.
    reportedOffset = Math.max(
      reportedOffset,
      Math.min(Math.max(0, candidate), file.size)
    );
    onProgress?.(reportedOffset, file.size);
  };

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
    let maxAttemptSent = 0;
    // How long each attempt at THIS chunk lasted. Collected because the ladder
    // spends the same number of rungs whether the connection is slow or the
    // request is refused instantly, and those are different faults — see
    // attemptMs on TusUploadError.
    const attemptMs: number[] = [];

    for (let attempt = 0; attempt < CHUNK_RETRY_DELAYS.length; attempt++) {
      attemptSent = 0;
      try {
        // Cleared before the wait, so a failure that lands while sleeping cannot
        // charge the backoff we chose to the attempt before it.
        attemptStartedAt = 0;
        if (CHUNK_RETRY_DELAYS[attempt] > 0) await sleep(CHUNK_RETRY_DELAYS[attempt], signal);
        attemptStartedAt = Date.now();
        offset = await sendChunk(
          location,
          blob,
          chunkStart,
          credentials,
          (loaded) => {
            attemptSent = Math.max(0, Math.min(loaded, blob.size));
            maxAttemptSent = Math.max(maxAttemptSent, attemptSent);
            reportProgress(chunkStart + attemptSent);
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

        // Before anything else, because it is about THIS attempt only: how long
        // it lasted. Zero means it failed inside the backoff sleep, and such an
        // attempt gets no entry rather than a misleading duration.
        if (attemptStartedAt > 0) attemptMs.push(Date.now() - attemptStartedAt);

        // Cancelled or refused outright: retrying cannot help.
        if (!isRetryableUploadFailure(tusError)) {
          throw withProgress(tusError, chunkStart + maxAttemptSent, file.size, {
            offset: chunkStart,
            chunkIndex,
            retryCount: attempt,
            attemptMs,
          });
        }

        lastError = tusError;

        // The server may already hold part of this chunk — ask before resending
        // from the old offset, otherwise the chunk is written twice.
        const serverOffset = await remoteOffset(location, credentials, signal);
        if (
          serverOffset !== null &&
          serverOffset > chunkStart &&
          Number.isInteger(serverOffset) &&
          serverOffset <= chunkStart + blob.size &&
          serverOffset <= file.size
        ) {
          offset = serverOffset;
          lastError = null;
          break;
        }

        // Said out loud before the backoff, because the alternative is a
        // percentage that sits still for eight seconds and reads as a hang.
        onRetry?.({
          chunkIndex,
          attempt: attempt + 1,
          totalAttempts: CHUNK_RETRY_DELAYS.length,
          offset: chunkStart,
          reason: tusError.reason,
        });
      }
    }

    if (lastError) {
      // The whole ladder is spent and the chunk never moved. If the device had
      // already refused to read this file, that is the answer, and it is said in
      // the device's own words rather than as a dropped connection.
      throw blameTheDeviceIfNothingMoved(
        withProgress(lastError, chunkStart + maxAttemptSent, file.size, {
          offset: chunkStart,
          chunkIndex,
          // Every attempt in the ladder was spent on this one chunk. Zero means
          // the first try died, which is a different finding from a connection
          // that refused it six times over a minute.
          retryCount: CHUNK_RETRY_DELAYS.length - 1,
          attemptMs,
        }),
        deviceRefusal
      );
    }
    reportProgress(offset);
    chunkIndex += 1;

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
