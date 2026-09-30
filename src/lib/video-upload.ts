// =============================================================================
// GENHUB - One video upload transport
//
// Videos go straight from the creator's browser to Bunny Stream using Bunny's
// resumable TUS endpoint. The application server only creates the upload session
// and finalizes the database row; it never proxies video bytes and never moves a
// completed file through a second storage provider.
//
// THE SIZE OF ONE REQUEST IS THE WHOLE STORY
//
// This file used to send a fixed 16 MiB slice per PATCH under a fixed
// 120-second timeout, and that pair is where every "connection interrupted" and
// "connection timed out" report came from. 16 MiB at the 0.4 Mbps this
// application has measured on a real creator's phone is 134,217,728 bits /
// 400,000 bps = 335 seconds — almost three times the timeout it was given. So
// the page aborted its own request mid-body, called it a network failure,
// resumed from the same byte and failed again, five times, for ten minutes,
// without moving a single byte closer to the end. On a good connection the same
// code was perfectly fine, which is why it survived so long.
//
// Both numbers now come from the connection instead of from a constant:
//
//   * the slice targets VIDEO_UPLOAD_TARGET_CHUNK_MS of measured transfer, so
//     every request is roughly the same short length whether the link is 0.4
//     Mbps or 100 Mbps;
//   * the timeout is four times that chunk's own expected duration, with a
//     floor, so a slow link is given room and a fast one is not made to wait.
//
// Nothing else about the protocol changed: the offset Bunny REPORTS is still
// the one used, a 409 still re-asks instead of retrying, and a refusal Bunny
// answered is still not retried.
//
// WHO OPENS THE UPLOAD, AND WHY IT MATTERS
//
// Bunny's TUS resource is visible only from the network that created it. An
// upload opened by the application server — one Vercel function, in one region —
// answers every later HEAD and PATCH from a creator's phone with an empty 404
// "Not Found". A live run on an emulator showed exactly that: the same URL with
// the same valid signature returned 200 (offset 0) to the server that opened it
// and 404 to the phone that had to fill it, and real uploads died at a few
// percent with Bunny's own words in the failure list.
//
// So the slot is still created server-side and its credentials are still signed
// there — but the create POST is made from HERE, in the browser, before the
// first chunk, in the same place the bytes come from. That is Bunny's own
// documented shape for a browser upload (their signing example hands the
// presigned headers to a client-side TUS library), and it is why
// `openVideoUpload` exists instead of a ready-made `uploadUrl` in the session.
// =============================================================================

export const MAX_VIDEO_BYTES = 2_147_483_647;

/** The smallest slice worth a round trip. Also the starting slice, because the
 *  first attempt is the one made blind. */
export const VIDEO_UPLOAD_MIN_CHUNK_BYTES = 1024 * 1024;

/** The largest slice one request may carry. A ceiling rather than a target: a
 *  fast link earns bigger requests, never one that takes a minute. */
export const VIDEO_UPLOAD_MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * How long one PATCH should last, in milliseconds.
 *
 * This is the number every other number here is derived from. Forty-five
 * seconds is long enough that a per-request overhead (TCP, TLS, Bunny's own
 * bookkeeping) is noise, and short enough that a carrier that resets idle or
 * long-lived sockets rarely gets the chance — which is the fault that produced
 * most of the NETWORK rows in the failure list.
 */
export const VIDEO_UPLOAD_TARGET_CHUNK_MS = 45_000;

/**
 * The slowest link this transport plans for: 200 kbps.
 *
 * Only used until a chunk has actually been sent. It is deliberately *below*
 * the slowest connection measured on a real creator's phone (0.4 Mbps down),
 * because underestimating makes the first request small and cheap to abandon,
 * while overestimating makes it the very time bomb this file was rewritten to
 * remove.
 */
export const VIDEO_UPLOAD_FLOOR_BPS = 25 * 1024;

/** A request is allowed four times its expected duration before it is called a
 *  timeout. The ratio is the headroom: a link that halves mid-chunk still
 *  finishes, and one that has genuinely stopped is abandoned in a bounded time. */
export const VIDEO_UPLOAD_TIMEOUT_FACTOR = 4;
export const VIDEO_UPLOAD_MIN_TIMEOUT_MS = 90_000;
export const VIDEO_UPLOAD_MAX_TIMEOUT_MS = 600_000;

/** How many times one chunk may be attempted before the upload gives up. */
export const VIDEO_UPLOAD_MAX_ATTEMPTS = 5;

/**
 * Why this file cannot be uploaded, or null when it can.
 *
 * Checked in the browser before a session is created, because the alternative is
 * a reserved Bunny slot and a round trip spent on a file that can never be sent
 * — and because the schema's own refusal ("number must be less than or equal to
 * 2147483647") is not a sentence a creator can act on.
 */
export function videoFileSizeError(file: { size: number }): string | null {
  if (!file.size) return "That file is empty";
  if (file.size > MAX_VIDEO_BYTES) return "Choose a video up to 2 GB";
  return null;
}

/** Bunny's resumable endpoint, and the only host this module will send video
 *  bytes to. The create POST and every PATCH below both go here. */
export const VIDEO_UPLOAD_TUS_ENDPOINT = "https://video.bunnycdn.com/tusupload";
const VIDEO_UPLOAD_TUS_HOST = "video.bunnycdn.com";

/** How long Bunny is given to open an upload resource. It answers in about a
 *  second when it is healthy, so this only bounds a hang. */
export const VIDEO_UPLOAD_CREATE_TIMEOUT_MS = 30_000;

/**
 * What the server signs and hands to the browser.
 *
 * `headers` are Bunny's own presigned credentials: a SHA-256 over the library
 * id, the key, the expiry and the video id. They are safe to hand over by
 * design — the library KEY is not one of them — and they are what let the
 * browser open the upload itself. There is deliberately no `uploadUrl` here:
 * the browser learns it from Bunny, at the moment it opens the upload.
 */
export interface VideoUploadSession {
  sessionToken: string;
  videoId: string;
  headers: Record<string, string>;
  totalBytes: number;
  mimeType: string;
  expiresAt: number;
}

/** Everything one PATCH needs: where to send it, with what, and how much. */
export interface VideoUploadTarget {
  uploadUrl: string;
  headers: Record<string, string>;
  totalBytes: number;
}

/** A session whose upload resource this browser has already opened. */
export type OpenedVideoUpload = VideoUploadSession & { uploadUrl: string };

export interface VideoUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Open the resumable upload, from here rather than from the server.
 *
 * The slot (and the id every later step refers to) was created server-side, and
 * these credentials were signed there, so no API key is involved on this side.
 * What this request does is register the upload with the Bunny node the browser
 * is actually talking to — the one that will have to accept every byte.
 *
 * `Location` comes back relative ("tusupload/<id>"), so it is resolved against
 * Bunny's own endpoint and then checked: it is the single field that decides
 * where a creator's video goes, and data: URLs and lookalike hosts both parse.
 */
export async function openVideoUpload(session: VideoUploadSession): Promise<OpenedVideoUpload> {
  const metadata = `filetype ${btoa(session.mimeType || "video/mp4")},title ${btoa(session.videoId)}`;

  let response: Response;
  try {
    response = await fetch(VIDEO_UPLOAD_TUS_ENDPOINT, {
      method: "POST",
      headers: {
        ...session.headers,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(session.totalBytes),
        "Upload-Metadata": metadata,
      },
      signal: AbortSignal.timeout(VIDEO_UPLOAD_CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : null;
    throw new VideoUploadError(
      "NETWORK",
      "The video service could not be reached to start this upload. Press Resume upload to try again.",
      undefined,
      { reason: "reset", stage: "reserve", providerBody: detail }
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoUploadError(
      "HTTP",
      `The video service would not open this upload (HTTP ${response.status}). Press Resume upload to try again.`,
      response.status,
      { reason: "provider", stage: "reserve", providerBody: body.slice(0, 300) || response.statusText || null }
    );
  }

  const location = response.headers.get("location");
  let url: URL | null = null;
  try {
    url = location ? new URL(location, VIDEO_UPLOAD_TUS_ENDPOINT) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.hostname !== VIDEO_UPLOAD_TUS_HOST) {
    throw new VideoUploadError(
      "HTTP",
      "The video service opened this upload somewhere unexpected, so nothing was sent. Press Resume upload to try again.",
      502,
      { reason: "provider", stage: "reserve", providerBody: location ? location.slice(0, 200) : null }
    );
  }

  return { ...session, uploadUrl: url.toString() };
}

/**
 * WHY a transfer died, in one word.
 *
 * `code` is the verdict the uploader reached; this is the physical fact behind
 * it. They are not interchangeable: `NETWORK` with no HTTP status covers a phone
 * that lost signal, a socket a carrier reset, and a request our own timer
 * aborted, and those need three different answers. Without this field every one
 * of them arrived in the admin panel as the same word.
 *
 * The list is closed and unchanged from the transport this one replaced, because
 * failure records written by the old uploader are still stored (thirty days) and
 * a vocabulary that dropped a word would make yesterday's history unreadable.
 */
export const UPLOAD_FAILURE_REASONS = [
  "offline",
  "reset",
  "stall",
  "timeout",
  "provider",
  "cancelled",
  "preflight",
] as const;

export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

/** Which request died. `reserve` is the session-creation POST; `chunk` is a
 *  PATCH. `put` is kept because records written by the whole-file uploader are
 *  still in the list. */
export type UploadStage = "reserve" | "chunk" | "put";

export class VideoUploadError extends Error {
  readonly code:
    | "INVALID_FILE"
    | "NETWORK"
    | "HTTP"
    | "CONFLICT"
    | "EXPIRED"
    | "ABORTED";
  readonly status?: number;

  /**
   * The evidence a reader needs to act, carried on the error rather than
   * reconstructed from a message string later.
   *
   * Every one of these is optional so nothing that only needs a message has to
   * build them, and every one is a fact rather than a guess:
   *
   *   reason        which physical fault this was.
   *   providerBody  Bunny's own words, verbatim, when it answered at all.
   *   bytesSent     the last byte Bunny confirmed. With a single PATCH there is
   *                 no upload-progress event to read, so this is the offset the
   *                 failing request STARTED from — a floor, and the number that
   *                 says whether the transfer was moving or never got going.
   *   attemptMs     how long each attempt lasted. Three attempts of 8 ms never
   *                 left the device; three of 40 s were cut mid-transfer, and
   *                 those are the same row on screen and different fixes.
   */
  reason?: UploadFailureReason;
  stage?: UploadStage;
  providerBody?: string;
  bytesSent?: number;
  bytesTotal?: number;
  offset?: number;
  chunkIndex?: number;
  retryCount?: number;
  attemptMs?: number[];

  constructor(
    code: VideoUploadError["code"],
    message: string,
    status?: number,
    extra?: {
      reason?: UploadFailureReason;
      stage?: UploadStage;
      /** `null` is accepted so a call site can pass an optional response body
       *  straight through instead of writing a conditional spread for it. */
      providerBody?: string | null;
    }
  ) {
    super(message);
    this.name = "VideoUploadError";
    this.code = code;
    this.status = status;
    this.reason = extra?.reason;
    this.stage = extra?.stage;
    if (extra?.providerBody) this.providerBody = extra.providerBody.slice(0, 600);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function now(): number {
  return Date.now();
}

/** The retry ladder: 0.5 s, 1 s, 2 s, 4 s, capped at 5 s. */
function retryDelay(attempt: number): number {
  return Math.min(5_000, 500 * 2 ** Math.max(0, attempt - 1));
}

/** True when the device itself says it has no network. Only a hint — Chrome
 *  reports `onLine: true` for a captive portal — but it is the one cause we can
 *  name without guessing, and it is the one the creator can act on. */
function deviceIsOffline(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  } catch {
    return false;
  }
}

/**
 * How long one PATCH may live.
 *
 * Derived from the slice and the rate we have measured, not from a constant: a
 * small request on a slow link and a big request on a fast one both get the same
 * generous multiple of the time they should need. The result is stable at about
 * four times the target chunk duration, and it is only ever wider than that when
 * a clamp gets in the way.
 */
export function chunkTimeoutMs(chunkBytes: number, rateBps: number | null): number {
  const rate = rateBps && rateBps > 0 ? rateBps : VIDEO_UPLOAD_FLOOR_BPS;
  const expectedMs = (chunkBytes / rate) * 1000;
  const timeout = expectedMs * VIDEO_UPLOAD_TIMEOUT_FACTOR;
  return Math.round(
    Math.min(VIDEO_UPLOAD_MAX_TIMEOUT_MS, Math.max(VIDEO_UPLOAD_MIN_TIMEOUT_MS, timeout))
  );
}

/**
 * How big the next slice should be.
 *
 * The rule is one sentence: a slice should take about VIDEO_UPLOAD_TARGET_CHUNK_MS.
 * On a phone at 50 KB/s that is roughly 2 MiB, so a 145 MB video is about
 * seventy short requests instead of nine requests that each outlive the
 * connection carrying them. On fibre it climbs to the ceiling and the per-request
 * overhead disappears.
 */
export function chunkBytesFor(rateBps: number | null, remaining: number): number {
  const rate = rateBps && rateBps > 0 ? rateBps : VIDEO_UPLOAD_FLOOR_BPS;
  const target = Math.round((rate * VIDEO_UPLOAD_TARGET_CHUNK_MS) / 1000);
  const bounded = Math.min(
    VIDEO_UPLOAD_MAX_CHUNK_BYTES,
    Math.max(VIDEO_UPLOAD_MIN_CHUNK_BYTES, target)
  );
  return Math.max(1, Math.min(remaining, bounded));
}

/**
 * Fold one completed slice into the throughput estimate.
 *
 * Moved halfway toward what was just observed rather than replaced by it: one
 * fast slice on a link that is briefly good should not triple the size of the
 * next request, and one slow slice on a link that hit a queue should not shrink
 * it to the floor for the rest of the upload. Halving the distance still doubles
 * the estimate within two slices, which is fast enough for a fast connection.
 */
export function measureRate(
  bytes: number,
  elapsedMs: number,
  previous: number | null
): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || bytes <= 0) return previous;
  const observed = (bytes / elapsedMs) * 1000;
  if (previous === null) return observed;
  return previous + (observed - previous) * 0.5;
}

/**
 * Turn a rejected `fetch` into the error the rest of the application reads.
 *
 * A rejected fetch is only ever one of three things, and only the last is
 * ambiguous — which is why the reason travels with it:
 *
 *   1. our own abort, which is a cancellation;
 *   2. a timer we armed, which is a timeout;
 *   3. the browser refusing to complete the exchange. That covers a dropped
 *      socket, a carrier reset, a preflight the host rejected, and a device with
 *      no route to the internet, and the browser deliberately tells a script
 *      nothing that would distinguish them. `navigator.onLine` splits off the
 *      one case we can actually name.
 */
function transportFailure(error: unknown, timeoutMs: number, cancelled: boolean): VideoUploadError {
  if (cancelled) return new VideoUploadError("ABORTED", "Upload cancelled");

  if (error instanceof DOMException && error.name === "AbortError") {
    return new VideoUploadError(
      "NETWORK",
      "The upload stopped moving. Press Resume upload to continue from where it stopped.",
      undefined,
      { reason: "timeout", providerBody: `aborted after ${Math.round(timeoutMs / 1000)}s` }
    );
  }

  if (deviceIsOffline()) {
    return new VideoUploadError(
      "NETWORK",
      "You are offline. Move back to signal, then press Resume upload.",
      undefined,
      { reason: "offline" }
    );
  }

  const detail =
    error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
  return new VideoUploadError(
    "NETWORK",
    "The connection dropped while sending this video. Press Resume upload to continue from where it stopped.",
    undefined,
    { reason: "reset", providerBody: detail }
  );
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();

  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw transportFailure(error, timeoutMs, Boolean(init.signal?.aborted));
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

/** How much of the file is already acknowledged, in whole percent. */
function percentOf(offset: number, total: number): number {
  if (!total) return 0;
  return Math.min(99, Math.max(0, Math.floor((offset / total) * 100)));
}

async function readOffset(
  session: VideoUploadTarget,
  signal?: AbortSignal
): Promise<number> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      session.uploadUrl,
      {
        method: "HEAD",
        headers: { ...session.headers, "Tus-Resumable": "1.0.0" },
        cache: "no-store",
        signal,
      },
      VIDEO_UPLOAD_MIN_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof VideoUploadError && error.code === "ABORTED") throw error;
    const failure =
      error instanceof VideoUploadError
        ? error
        : new VideoUploadError("NETWORK", "Could not check the saved upload position");
    failure.message = "Could not check the saved upload position";
    throw failure;
  }

  if (response.status === 401 || response.status === 403) {
    throw new VideoUploadError(
      "EXPIRED",
      "The upload session expired. Please choose the video again.",
      response.status
    );
  }
  if (response.status === 404) {
    // Bunny answers 404 — not 401 — both for an upload it no longer has and for
    // a request that reached it without the signed headers, so the sentence says
    // what is known and carries the number for whoever reads it next.
    throw new VideoUploadError(
      "EXPIRED",
      `The video service has closed this upload (HTTP ${response.status}). Please choose the video again.`,
      response.status
    );
  }
  if (!response.ok) {
    throw new VideoUploadError("HTTP", "The video service could not resume this upload", response.status);
  }

  const offset = Number(response.headers.get("upload-offset") || "0");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.totalBytes) {
    throw new VideoUploadError("HTTP", "The video service returned an invalid upload position");
  }
  return offset;
}

function nextOffset(response: Response, current: number, sent: number, total: number): number {
  const header = Number(response.headers.get("upload-offset") || "");
  const offset = Number.isSafeInteger(header) ? header : current + sent;
  if (offset <= current || offset > total) {
    throw new VideoUploadError("HTTP", "The video service returned an invalid upload position");
  }
  return offset;
}

/** The offset a 409 claims Bunny holds, when it names one — otherwise null. */
function offsetFromConflict(body: string): number | null {
  const match = /file offset:\s*(\d+)/i.exec(body);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

/**
 * Upload one file, resuming from the offset Bunny already has.
 *
 * The loop is deliberately re-entrant about its own position: every attempt
 * re-reads `offset` from the variable rather than from the slice it started
 * with, so a recovery HEAD (after a reset, or a 409) moves the next request
 * forward instead of re-sending bytes Bunny has already stored.
 */
export async function uploadVideoFile(
  file: File,
  session: VideoUploadTarget,
  options: {
    onProgress?: (progress: VideoUploadProgress) => void;
    signal?: AbortSignal;
    /**
     * Where to start, when it is already known.
     *
     * An upload this browser has just opened holds nothing, and that is not a
     * guess: Bunny answers a brand-new TUS resource with offset 0. Supplying it
     * removes the opening HEAD, which is one round trip off every upload and —
     * on a connection slow enough to lose it — one more way for the transfer to
     * die before it has sent a byte. Omitted for a RESUMED session, where the
     * offset is exactly the thing that has to be asked for.
     */
    offset?: number;
  } = {}
): Promise<void> {
  if (!file || !file.size) {
    throw new VideoUploadError("INVALID_FILE", "Choose a video up to 2 GB");
  }
  const sizeError = videoFileSizeError(file);
  if (sizeError) throw new VideoUploadError("INVALID_FILE", sizeError);
  if (file.size !== session.totalBytes) {
    throw new VideoUploadError(
      "INVALID_FILE",
      "The selected file is different from the upload session. Choose it again."
    );
  }

  const total = file.size;
  const report = options.onProgress;
  let offset = options.offset ?? (await readOffset(session, options.signal));
  /** Learned, never assumed: null until a slice has actually been sent. */
  let rateBps: number | null = null;
  report?.({ uploadedBytes: offset, totalBytes: total, percent: Math.round((offset / total) * 100) });

  let chunkIndex = 0;

  while (offset < total) {
    chunkIndex += 1;
    const attemptMs: number[] = [];
    let advanced = false;
    let lastError: VideoUploadError | null = null;

    for (let attempt = 1; attempt <= VIDEO_UPLOAD_MAX_ATTEMPTS && !advanced; attempt += 1) {
      if (options.signal?.aborted) {
        throw new VideoUploadError("ABORTED", "Upload cancelled");
      }

      // Sliced from THIS attempt's offset: after a recovery HEAD the request has
      // to continue where Bunny is, not where the previous attempt began.
      const chunkBytes = chunkBytesFor(rateBps, total - offset);
      const end = Math.min(total, offset + chunkBytes);
      const timeoutMs = chunkTimeoutMs(chunkBytes, rateBps);
      const startedAt = now();
      let retryCount = attempt - 1;

      try {
        const response = await fetchWithTimeout(
          session.uploadUrl,
          {
            method: "PATCH",
            headers: {
              ...session.headers,
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": String(offset),
              "Content-Type": "application/offset+octet-stream",
            },
            body: file.slice(offset, end),
            cache: "no-store",
            signal: options.signal,
          },
          timeoutMs
        );

        if (response.status === 409 || response.status === 412) {
          // Our belief and Bunny's disagree — the file is fine and the offset is
          // stale, so this is not a failure and must not spend the retry budget.
          // The chunk counts as settled and the outer loop re-slices from
          // wherever Bunny turns out to be.
          attemptMs.push(now() - startedAt);
          const body = await response.text().catch(() => "");
          const claimed = offsetFromConflict(body);

          // Bunny's OWN figure first, because the refusal it just sent is the
          // most direct answer available: "Offset does not match file. File
          // offset: 10." It is Bunny stating what it holds, measured against the
          // live API, and it cannot be mistaken for anything else.
          //
          // The HEAD is only the fallback, and that order matters. A signed HEAD
          // answers 404 the moment Bunny no longer has the resource — with no
          // way to tell that apart from "you sent no signature" — and four live
          // failure records in the admin panel are exactly that: an upload that
          // got this far and then died on a confirmation request. Asking Bunny
          // to confirm something it has already told us is a round trip that can
          // only lose information.
          if (claimed !== null && claimed > offset && claimed <= total) {
            offset = claimed;
          } else {
            offset = await readOffset(session, options.signal);
          }
          advanced = true;
          report?.({ uploadedBytes: offset, totalBytes: total, percent: percentOf(offset, total) });
          break;
        }

        if (response.status === 401 || response.status === 403) {
          throw new VideoUploadError(
            "EXPIRED",
            "The upload session expired. Please choose the video again.",
            response.status
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new VideoUploadError(
            "HTTP",
            `The video service refused a chunk (HTTP ${response.status})`,
            response.status,
            {
              reason: "provider",
              providerBody: body || response.statusText || null,
            }
          );
        }

        advanced = true;
        const elapsed = now() - startedAt;
        attemptMs.push(elapsed);
        rateBps = measureRate(end - offset, elapsed, rateBps);
        offset = nextOffset(response, offset, end - offset, total);
      } catch (error) {
        attemptMs.push(now() - startedAt);

        if (error instanceof VideoUploadError && error.code === "ABORTED") throw error;

        if (
          error instanceof VideoUploadError &&
          (error.code === "EXPIRED" ||
            (error.code === "HTTP" &&
              error.status !== undefined &&
              error.status < 500 &&
              error.status !== 409 &&
              error.status !== 412))
        ) {
          throw error;
        }

        lastError =
          error instanceof VideoUploadError
            ? error
            : new VideoUploadError("NETWORK", "The upload connection was interrupted", undefined, {
                reason: "reset",
              });

        if (attempt === VIDEO_UPLOAD_MAX_ATTEMPTS) break;

        retryCount = attempt;
        await sleep(retryDelay(attempt));

        // If the PATCH reached Bunny before the response was lost, this HEAD
        // advances us without sending the same bytes twice.
        try {
          const recovered = await readOffset(session, options.signal);
          if (recovered > offset) {
            offset = recovered;
            report?.({ uploadedBytes: offset, totalBytes: total, percent: percentOf(offset, total) });
          }
        } catch (headError) {
          if (headError instanceof VideoUploadError && headError.code === "ABORTED") throw headError;
          // A session Bunny has genuinely closed is not worth the rest of the
          // ladder — resume cannot fix it, only a new session can.
          if (headError instanceof VideoUploadError && headError.code === "EXPIRED") {
            throw headError;
          }
          // Otherwise the next PATCH attempt can still recover if HEAD was the
          // request that lost the connection. Do not turn a temporary HEAD
          // failure into a permanent one before the retry budget is spent.
        }
      }

      if (advanced) break;

      // Attach the shape of the failure to the error that is about to be
      // retried: if this is the last attempt it is also the error that is
      // reported, and the offset, the chunk and the timings are what a reader
      // uses to tell a dead link from a refused request.
      if (lastError) {
        lastError.stage = "chunk";
        lastError.offset = offset;
        lastError.bytesSent = offset;
        lastError.bytesTotal = total;
        lastError.chunkIndex = chunkIndex;
        lastError.retryCount = retryCount;
        lastError.attemptMs = [...attemptMs];
      }
    }

    if (!advanced) {
      const failure =
        lastError ??
        new VideoUploadError("NETWORK", "The video chunk could not be saved", undefined, {
          reason: "reset",
        });
      failure.stage = "chunk";
      failure.offset = offset;
      failure.bytesSent = offset;
      failure.bytesTotal = total;
      failure.chunkIndex = chunkIndex;
      failure.attemptMs = [...attemptMs];
      failure.message = failureMessage(failure, offset, total);
      throw failure;
    }

    report?.({ uploadedBytes: offset, totalBytes: total, percent: percentOf(offset, total) });
  }

  report?.({ uploadedBytes: total, totalBytes: total, percent: 100 });
}

/**
 * The sentence the creator reads, built from where the transfer actually got to.
 *
 * A percentage is the only part of this that a creator can act on. "The
 * connection dropped" alone invites them to start again from zero — the single
 * most expensive thing they could do on a metered phone — while "43% sent, press
 * Resume" tells them their data is not lost and roughly what is left.
 */
function failureMessage(failure: VideoUploadError, offset: number, total: number): string {
  const sent = total ? `${Math.floor((offset / total) * 100)}% sent` : "nothing sent yet";
  switch (failure.reason) {
    case "offline":
      return `You are offline (${sent}). Move back to signal, then press Resume upload.`;
    case "timeout":
      return `The connection stopped carrying data (${sent}). Press Resume upload to continue.`;
    case "provider":
      return failure.message;
    default:
      return `The connection dropped while sending this video (${sent}). Press Resume upload to continue from there.`;
  }
}

export async function completeVideoUpload(sessionToken: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/videos/upload-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
    });
  } catch {
    throw new VideoUploadError("NETWORK", "The upload finished, but Genhub could not confirm it", undefined, {
      reason: "reset",
      stage: "reserve",
    });
  }

  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { videoId?: string };
  } | null;

  if (!response.ok || !body?.success || !body.data?.videoId) {
    throw new VideoUploadError(
      response.status === 409 ? "CONFLICT" : "HTTP",
      body?.error || "Genhub could not confirm the completed upload",
      response.status,
      { stage: "reserve", providerBody: body?.error || null }
    );
  }
  return body.data.videoId;
}

export async function abortVideoUpload(sessionToken: string): Promise<void> {
  await fetch("/api/videos/upload-abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken }),
    keepalive: true,
  }).catch(() => undefined);
}
