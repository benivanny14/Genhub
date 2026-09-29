// =============================================================================
// GENHUB - Client-side image upload helper
// Shared by the KYC form, the creator thumbnail picker and the profile avatar:
// posts the file to /api/upload and resolves with the in-app URL that serves it
// (`/api/media/...`).
//
// `kind` is required rather than defaulted for the private bucket. Asking a
// caller to write `kind: "private"` for an identity document makes the privacy
// decision visible at the call site; a silent default is how an ID photo ends up
// in the public bucket. Public stays the default because that is what most
// callers are (a thumbnail, an avatar).
// =============================================================================

import { downscaleImage } from "./image-downscale";
import { TusUploadError, type TusFailureReason } from "./tus-upload";

export class UploadError extends Error {}

export interface UploadOptions {
  /** "public" (default) — anyone can read it. "private" — owner and admins. */
  kind?: "public" | "private";
}

// A phone photo is routinely 4-8 MB before it is cropped, so the image ceiling
// is 10 MB. Captions are text and stay at 5 MB — see /api/upload for the
// server-side cap, which is what actually enforces this.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTION_BYTES = 5 * 1024 * 1024;

/** One POST, one failure message, shared by every caller in this file. */
async function post(file: File, kind: "public" | "private", what: string): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);

  let res: Response;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form });
  } catch {
    throw new UploadError(`Network error — the ${what} was not uploaded`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new UploadError(data?.error || `The ${what} could not be uploaded`);
  }
  return data.data.url as string;
}

export async function uploadImage(file: File, options: UploadOptions = {}): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new UploadError("Please choose an image file");
  }
  // Shrink a big phone photo here, before it is sent. This is what keeps a
  // normal picture under the hosting platform's request-body cap (4.5 MB on
  // Vercel) and under our own 10 MB limit — and it means what the server
  // receives is already the size it wants.
  const prepared = await downscaleImage(file);

  if (prepared.size > MAX_IMAGE_BYTES) {
    throw new UploadError("Image is too large (max 10 MB)");
  }

  return post(prepared, options.kind ?? "public", "image");
}

/**
 * A WebVTT captions file.
 *
 * Checked by extension rather than MIME type, because the type a browser reports
 * for a .vtt is inconsistent (`text/vtt`, `text/plain`, or empty depending on the
 * OS and how the file was picked) and the server accepts all three. The suffix
 * is what the player requires anyway: a browser handed an .srt shows nothing and
 * logs nothing.
 */
export async function uploadCaptions(file: File): Promise<string> {
  if (!/\.vtt$/i.test(file.name)) {
    throw new UploadError("Captions must be a .vtt (WebVTT) file — .srt will not play");
  }
  if (file.size > MAX_CAPTION_BYTES) {
    throw new UploadError("Captions file is too large (max 5 MB)");
  }

  return post(file, "public", "captions file");
}

// =============================================================================
// Reporting a failed VIDEO upload
// =============================================================================
// Video bytes never pass through this app's server — the browser streams them
// straight to Bunny — so a transfer that dies leaves no server-side trace at
// all. The video row is created only AFTER the upload finishes, which means a
// failed one produces no row, no log line and nothing on any admin screen. The
// creator gets a toast, and the reason is gone the moment the tab closes.
//
// That is how a live library ended up with more orphaned slots (14) than video
// rows (9), ten of them holding zero bytes, with the only description of the
// fault being a screenshot. These two functions are the other half: they post
// what actually happened — Bunny's HTTP status, Bunny's own response body, which
// request died, and the reserved slot — so /admin can answer "why is this
// failing?" for itself.
//
// Best effort by design. It never throws and never delays the message the
// creator is already reading: a report that cannot be delivered is one missing
// line in a list, which is strictly better than a second error on top of the
// first.

export interface UploadFailureReport {
  /** TusUploadError.code, or UNKNOWN for anything else. */
  code: string;
  stage?: "reserve" | "chunk" | null;
  status?: number | null;
  message: string;
  providerBody?: string | null;
  bunnyVideoId?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  /**
   * How far the transfer had got when it died, and the file's size.
   *
   * The two facts that turn "NETWORK" into an answer: a bare zero with no HTTP
   * status is a request that never got going (blocked, offline, refused or reset
   * on the way out), while tens of megabytes with the same absent status is a
   * transfer that was already moving and stopped. Everything else in a report is
   * the same for both. The figure is what the browser REPORTED through its
   * upload-progress event, and it coalesces those — so zero means "never
   * acknowledged", not "nothing was sent".
   */
  bytesSent?: number | null;
  bytesTotal?: number | null;
  /**
   * Which physical fault it was: offline, reset, stall, timeout, provider,
   * cancelled or preflight.
   *
   * The code alone cannot say: offline and reset are both NETWORK with no
   * status, a stall and a timeout are both "the upload stalled", and a phone
   * that has lost signal reads exactly like a proxy that reset the socket.
   * Whoever reads the report needs that distinction to know whether to wait,
   * to retry, or to go and look at Bunny.
   */
  reason?: TusFailureReason | null;
  /**
   * The offset the failing chunk started at — what a retry would resume from.
   * Unlike `bytesSent` this is the SERVER's figure, so it is a floor rather
   * than a client-side estimate.
   */
  offset?: number | null;
  /** Which chunk died, counting from zero. */
  chunkIndex?: number | null;
  /** How many retries at that chunk had already been spent. */
  retryCount?: number | null;
  /**
   * How long each attempt at that chunk lasted, in milliseconds, oldest first.
   *
   * Retry count and this together say which fault it was. Six attempts that each
   * ended in ten milliseconds is a request that never gets going — a blocked or
   * refused connection — while six attempts of forty seconds each is a transfer
   * that keeps being cut, which wants smaller chunks. Both record `retryCount: 5`
   * and, with no HTTP status on either, are otherwise the same row.
   */
  attemptMs?: number[] | null;
}

/**
 * What the browser knows about its own connection, when it knows anything.
 *
 * `navigator.connection` is Chrome-only, so these are all nullable by design —
 * a missing value is not a fault, it is a browser that does not offer the field.
 * It is worth asking for anyway: `effectiveType` distinguishes a phone on 2G
 * from one on WiFi, and `downlink` turns "the connection dropped" into a number
 * a support answer can be based on.
 */
export interface UploadNetworkSnapshot {
  connectionType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
}

/** The few members of the Network Information API this reads. */
interface NetworkInformationLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

const NO_NETWORK_INFO: UploadNetworkSnapshot = {
  connectionType: null,
  downlinkMbps: null,
  rttMs: null,
};

export function readNetworkSnapshot(): UploadNetworkSnapshot {
  try {
    const connection =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Navigator & { connection?: NetworkInformationLike }).connection;

    return {
      connectionType:
        typeof connection?.effectiveType === "string" ? connection.effectiveType : null,
      downlinkMbps: typeof connection?.downlink === "number" ? connection.downlink : null,
      rttMs: typeof connection?.rtt === "number" ? Math.round(connection.rtt) : null,
    };
  } catch {
    // This runs while a failure is being reported, and its return value is
    // spread into the payload — so a browser whose connection object throws on
    // access would take the WHOLE report down with it, discarding the Bunny
    // status and the offset that are the reason the report exists. The detail is
    // the optional half; losing it costs nothing, losing the rest costs the
    // incident.
    return NO_NETWORK_INFO;
  }
}

/**
 * Turn whatever was thrown into a report, keeping Bunny's own words.
 *
 * A TusUploadError carries the parts worth keeping — the code, the HTTP status
 * and the provider's body — and everything else is summarised. The message is
 * still sent, because it is what the creator read on screen, and a report that
 * does not match the complaint is hard to trust.
 */
export function describeUploadFailure(
  error: unknown,
  context: {
    bunnyVideoId?: string | null;
    fileName?: string | null;
    fileSize?: number | null;
  } = {}
): UploadFailureReport {
  if (error instanceof TusUploadError) {
    return {
      code: error.code,
      stage: error.stage ?? null,
      status: error.status ?? null,
      message: error.message,
      providerBody: error.providerBody ?? null,
      bytesSent: error.bytesSent ?? null,
      bytesTotal: error.bytesTotal ?? null,
      reason: error.reason ?? null,
      offset: error.offset ?? null,
      chunkIndex: error.chunkIndex ?? null,
      retryCount: error.retryCount ?? null,
      // Absent rather than empty when there was only ever one attempt with no
      // timing: a report that sometimes carries `[]` would make "no attempts
      // recorded" and "one attempt" read the same.
      attemptMs: error.attemptMs?.length ? error.attemptMs : null,
      ...context,
    };
  }

  return {
    code: "UNKNOWN",
    stage: null,
    status: null,
    message: error instanceof Error ? error.message : "Upload failed",
    providerBody: null,
    bytesSent: null,
    bytesTotal: null,
    reason: null,
    offset: null,
    chunkIndex: null,
    retryCount: null,
    attemptMs: null,
    ...context,
  };
}

/**
 * POST one report to the server. Never throws.
 *
 * The connection snapshot is added HERE, at the moment of sending, rather than
 * inside `describeUploadFailure`: it describes the link as the report goes out,
 * not the failure that produced it, and keeping the mapper pure is what lets the
 * shape of a report be tested without a browser standing in for a phone.
 */
export async function reportUploadFailure(report: UploadFailureReport): Promise<void> {
  try {
    await fetch("/api/videos/upload-failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...report, ...readNetworkSnapshot() }),
      // The creator is usually staring at the failure when this goes out, and
      // the next thing they do is close the tab or hit retry. keepalive lets the
      // request finish anyway.
      keepalive: true,
    });
  } catch {
    // Deliberately silent — see the note above.
  }
}
