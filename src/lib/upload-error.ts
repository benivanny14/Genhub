// =============================================================================
// GENHUB - The vocabulary every upload failure is reported in
//
// There is one upload transport now: a single presigned PUT from the browser
// straight into the storage bucket (lib/upload-put.ts). This file is what
// remains of the resumable uploader it replaced, and it remains because none of
// it was ever about chunking:
//
//   * the error shape, so a failure carries a code, a reason, a stage, the byte
//     counts and the per-attempt timings;
//   * the classification of a provider's answer (TRANSIENT_4XX, and what may
//     spend a retry);
//   * the read probe, which is the only way to tell a device that will not hand
//     over a file from a connection that will not carry it;
//   * the size limit and the sentence that refuses an oversized file.
//
// It is one file because the alternative is the bug this codebase has already
// been bitten by: two copies of a rule that drift, and a failure that gets
// classified one way and retried another (see TRANSIENT_4XX below).
// =============================================================================

/**
 * How long a transfer may move NO bytes before it is called a stall.
 *
 * Deliberately not `xhr.timeout`, which caps the WHOLE request — a throughput
 * limit wearing a stall detector's name. On a link slow enough that a large
 * upload needs more than three minutes of healthy transfer, that failed a
 * connection that was working perfectly and retried it from the beginning,
 * which is the shape of every "connection dropped" report this application has
 * ever received. The watchdog is re-armed by every progress event, so a slow
 * connection is left alone for as long as it takes and only a connection that
 * has genuinely stopped is abandoned.
 */
export const UPLOAD_STALL_TIMEOUT_MS = 90 * 1000;

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
 * Checked BEFORE the slot is reserved, so a file that is too large never creates
 * a Bunny object — see videoSizeError and the call sites.
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
 * transfer can send it.
 */
const READ_PROBE_BYTES = 1024;

/**
 * A creator-facing message when a file is over the limit, or null when it is
 * fine. Shared so the form can refuse the file early (no wasted slot) and the
 * transport can refuse it again as a last line of defence.
 */
export function videoSizeError(file: File): string | null {
  if (file.size <= MAX_VIDEO_BYTES) return null;
  const gb = file.size / (1024 * 1024 * 1024);
  return `That video is ${gb.toFixed(2)} GB — the limit is 2 GB. Trim or compress it and try again.`;
}

export type UploadErrorCode =
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
 * phone needs nothing from us but time, a reset connection wants the request
 * tried again, a stall usually means the tab was sent to the background, and a
 * provider error needs the provider's own body read. Before this field every one
 * of them arrived as the same word — NETWORK, with a null status — and the
 * reader could not tell which fault they were looking at.
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

/**
 * Which request died.
 *
 * `"put"` is the only value this application produces now. The other two are
 * kept in the type and accepted by the report schema because failure records
 * written by the chunked uploader are still stored — thirty days of them — and a
 * schema that rejects them would erase the history an operator reads to
 * understand what happened before the transport changed.
 */
export type UploadStage = "reserve" | "chunk" | "put";

/**
 * A video upload that failed, with everything a reader needs to say why.
 *
 * Named for the transport rather than just "upload" because upload-client.ts
 * already exports an `UploadError` for the simpler failures on the image and
 * caption paths — an endpoint that answered no. Two error types in one
 * application is bad enough; two with the same name would be a trap.
 */
export class VideoUploadError extends Error {
  code: UploadErrorCode;
  status?: number;
  /** Which request died, when the failure came off the wire rather than from a
   *  pre-flight check. Reported to the server so the failure leaves a record —
   *  see lib/services/upload-failure.service.ts. */
  stage?: UploadStage;
  /**
   * The provider's response body, verbatim.
   *
   * Its own field rather than only text inside the message, because the two are
   * written for different readers: the message is a sentence for the creator,
   * clipped for a toast, while this is the line that NAMES the cause — "Library
   * ID missing or invalid.", "Authentication has been denied." — and it is what
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
   * The offset the failing request started at.
   *
   * With one whole-file PUT that is always zero, and it is kept because the
   * failure records in the admin panel carry it and a report that sometimes has
   * a field is worse than one that never does — its absence would stop meaning
   * anything.
   */
  offset?: number;
  /**
   * How many retries preceded the attempt that died. Zero means the first
   * attempt failed; two (with the current ladder) means the host refused the
   * same request three times, which is a different finding from a single drop.
   */
  retryCount?: number;
  /**
   * How long each attempt lasted, in milliseconds, oldest first.
   *
   * The one measurement that tells "a link too slow to finish the request" apart
   * from "a request that never got going". Three attempts that each ended in
   * twelve milliseconds cannot be a transfer; three that each lasted forty
   * seconds are a transfer that keeps being cut, and the two need opposite
   * fixes. A count of retries alone says neither, because both spend the same
   * ladder.
   *
   * The backoff sleeps between attempts are deliberately NOT in these numbers: a
   * wait we chose is not evidence about a connection.
   */
  attemptMs?: number[];
  /** Which physical fault this was — see UploadFailureReason. */
  reason?: UploadFailureReason;

  constructor(
    code: UploadErrorCode,
    message: string,
    status?: number,
    extra?: {
      stage?: UploadStage;
      providerBody?: string;
      reason?: UploadFailureReason;
    }
  ) {
    super(message);
    this.name = "VideoUploadError";
    this.code = code;
    this.status = status;
    this.stage = extra?.stage;
    this.providerBody = extra?.providerBody;
    this.reason = extra?.reason;
  }
}

/**
 * The 4xx answers that mean "send the same bytes again", as opposed to "this
 * request is wrong".
 *
 * Listed once because two places have to agree about it: the classification of a
 * provider's answer and `isRetryableUploadFailure` both read it. When the two
 * lists drifted apart, a status could be classified transient and still not be
 * retried, which reads as a broken ladder.
 *
 *   408 the server gave up reading the request
 *   409 the request conflicts with what the host currently holds
 *   423 Locked — measured against the live API on a real device, when a session
 *       is still being let go of. Read as permanent, it ended an upload that was
 *       a quarter sent, on a connection that was working again.
 *   429 too many requests
 */
export const TRANSIENT_4XX: ReadonlySet<number> = new Set([408, 409, 423, 429]);

export interface UploadRetryInfo {
  /** The retry that is about to happen: 1 for the second attempt. */
  attempt: number;
  /** How many attempts this transfer is allowed in total. */
  totalAttempts: number;
  /** The offset the request is retried from. Zero on a whole-file PUT. */
  offset: number;
  /** The fault that spent the attempt, so the message can name it. */
  reason?: UploadFailureReason;
}

/**
 * A creator-facing sentence for the retry that is about to happen.
 *
 * The form used to sit at the same percentage through a backoff, which reads as
 * a hang — the creator cannot tell "still working" from "dead". Naming the fault
 * is the point: "you are offline" and "the host refused that attempt" lead to
 * different actions (move to better signal, or stop and tell us), while a silent
 * bar leads to giving up on a file that was one attempt from done.
 *
 * Pure, so the wording is pinned by a test rather than by a screenshot.
 *
 * Takes only the three fields it reads, so a caller can hand it whatever shape of
 * retry info it has: the byte count is the only thing that changes the sentence
 * a creator needs to read, and that is not in here.
 */
export function describeRetry(
  info: Pick<UploadRetryInfo, "attempt" | "totalAttempts" | "reason">
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

/**
 * Only transient transport/provider responses should consume a retry.
 *
 * The transient 4xx list is shared with the classifier so a status cannot be
 * called transient in one place and permanent in the other — see TRANSIENT_4XX.
 *
 * There is one transport now, and this stays a function because the rule it
 * encodes is a policy, not a property of the request: a retry that re-sends a
 * file the host will refuse again is the creator's data spent on a foregone
 * conclusion.
 */
export function isRetryableUploadFailure(error: VideoUploadError): boolean {
  if (error.code !== "NETWORK") return false;
  if (error.status === undefined || error.status === null) return true;
  return TRANSIENT_4XX.has(error.status) || error.status >= 500;
}

/**
 * What the device said when a scripted read of the picked file was refused.
 *
 * `name` is the browser's own error name — `NotReadableError` is the one that
 * means this — and `detail` keeps both parts for the record, because the name
 * alone will not explain a provider behaviour nobody has seen before.
 */
export interface DeviceReadRefusal {
  name: string;
  detail: string;
}

/**
 * Read one kilobyte, and REPORT a refusal rather than acting on it.
 *
 * Still worth its cost on every upload, including the ones that work: it is the
 * only way to know that the file itself was the problem rather than the link.
 * What matters is who decides — see blameTheDeviceIfNothingMoved below.
 */
export async function probeDeviceRead(file: File): Promise<DeviceReadRefusal | null> {
  try {
    await file.slice(0, READ_PROBE_BYTES).arrayBuffer();
    return null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    return {
      name,
      detail: error instanceof Error && error.message ? `${name}: ${error.message}` : name,
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
 * from blaming the phone for a link that died before anything could move: a file
 * this device never refused, on a transfer that never started, is the connection
 * as plainly as it ever was. Only together do they mean "this file, on this
 * device, cannot be handed over at all" — and that is a sentence the creator can
 * act on, which "the connection dropped" is not.
 *
 * Everything else about the failure is carried through — the offset it died at,
 * the ladder it spent and the timings — so the record in the admin panel stays
 * comparable with every other failure.
 *
 * The stage is checked rather than assumed, so a caller cannot have a failure
 * relabelled as a device fault when it was produced somewhere else.
 */
export function blameTheDeviceIfNothingMoved(
  error: VideoUploadError,
  refusal: DeviceReadRefusal | null,
  stage: UploadStage
): VideoUploadError {
  if (!refusal) return error;
  if (error.stage !== stage) return error;
  if (error.bytesSent !== 0) return error;

  error.code = "UNSUPPORTED";
  error.reason = "preflight";
  error.message =
    `This device would not let the page read that video (${refusal.name}), and nothing ever left the ` +
    "browser. Choose it again — the Files app usually works where a photos or cloud app does not — " +
    "or copy it onto the phone's own storage first.";
  // The provider never saw this one, so its own words are not what names the
  // cause — the DEVICE's are, and in the same field for the same reason.
  error.providerBody = refusal.detail.slice(0, 160);
  return error;
}
