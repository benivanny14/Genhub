// =============================================================================
// GENHUB - Failed video uploads: the record a failed upload never had
//
// The hole this fills is not subtle. The byte transfer happens in the creator's
// browser and goes STRAIGHT to Bunny, so the server never sees it — and the
// video row is only created after the transfer finishes. A failed upload
// therefore left nothing anywhere: no row to look at, no log line, no counter.
// The creator got a toast naming an HTTP status, and by the time anybody asked
// what that status was, the tab was closed.
//
// That is how a live library ended up with 14 orphaned slots against 9 rows —
// ten of them holding zero bytes — while the only description of the fault in
// existence was "videos nyingine zinakataa kabla ya byte ya kwanza". Nobody could
// act on that, and the workaround was to guess.
//
// So the browser now reports the failure through /api/videos/upload-failure and
// it lands in two places on purpose:
//
//   1. console.error — the hosting provider's log. Durable, searchable, and the
//      half that survives a Redis outage.
//   2. A bounded list in the cache, newest first, read by the admin panel. A log
//      line cannot be seen from the screen an operator is already looking at,
//      and "did this just happen again?" is the question worth answering at a
//      glance.
//
// STORAGE: the cache helpers degrade to a skipped write when Redis is
// unreachable (lib/redis.ts) and never throw, which is the right failure mode
// here — a failure to RECORD a failure must not become a third one. The list is
// deliberately small and expires: this is a debugging aid, not an audit trail.
// If a durable history is ever wanted, a table and a migration are the answer,
// and this module is the one place that has to change.
// =============================================================================

import { cacheGet, cacheSet } from "@/lib/redis";
import type { UploadFailureReason } from "@/lib/upload-error";

/** One key, so this cannot grow without bound. */
const FAILURES_KEY = "bunny:upload:failures";

/**
 * How many failures are kept.
 *
 * Enough to see a pattern (ten uploads in one evening, all ending the same way)
 * and small enough that the whole list is one cheap read the admin page can make
 * on every visit.
 */
const MAX_KEPT = 25;

/** Long enough that "it happened last week" is still answerable. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

export interface UploadFailure {
  /** When we heard about it, ISO. */
  at: string;
  /** VideoUploadError.code — EXPIRED / REJECTED / NETWORK / UNSUPPORTED / ABORTED. */
  code: string;
  /**
   * Which request died: the reserve POST, a chunk PATCH, or the whole-file PUT
   * through the upload proxy — the transport matters as much as the verdict.
   */
  stage: "reserve" | "chunk" | "put" | null;
  /** Bunny's HTTP status, or null when nothing answered. */
  status: number | null;
  /** What the creator was shown. */
  message: string;
  /**
   * The raw words that name the cause: Bunny's own response body, verbatim,
   * when there was a response — and the browser's own error (its `name` and
   * message) when the failure never left the device. Both belong here because
   * they are the same thing: the evidence nobody paraphrased.
   */
  providerBody: string | null;
  /** The reserved slot, so the orphan can be found (and cleaned) in Bunny. */
  bunnyVideoId: string | null;
  fileName: string | null;
  fileSize: number | null;
  /**
   * How far the transfer got, and how big the file is.
   *
   * A bare zero with a null status is a request that never got going; tens of
   * megabytes with the same null status is a transfer that was already moving.
   * Those are different faults with different fixes, and before these two fields
   * both were the single word "NETWORK". The count is what the browser reported
   * through its upload-progress event — it coalesces those, so zero is "never
   * acknowledged" rather than "nothing was sent".
   */
  bytesSent: number | null;
  bytesTotal: number | null;
  /**
   * Which physical fault it was: offline, reset, stall, timeout, provider,
   * cancelled or preflight.
   *
   * The code is a verdict and this is the cause, and one is often not enough.
   * `NETWORK` with a null status covers a phone that lost signal, a proxy that
   * reset the socket, and a tab that went to the background — three problems
   * with three different answers, and before this field the record could not
   * say which one had happened.
   */
  reason: UploadFailureReason | null;
  /**
   * The offset the failing chunk started at, which chunk it was, and how many
   * retries had already been spent on it.
   *
   * `offset` is the server's own figure (what a retry resumes from), so it is a
   * floor under the client-reported `bytesSent`; the pair together says whether
   * the connection died at the beginning or ninety per cent of the way in.
   */
  offset: number | null;
  chunkIndex: number | null;
  retryCount: number | null;
  /**
   * How long each attempt at that chunk lasted, in milliseconds, oldest first.
   *
   * The count of attempts says how patient the uploader was; this says what kind
   * of fault it was being patient with. An attempt that lasted twelve
   * milliseconds never put a request on the wire, so every rung of the ladder
   * was spent on a connection that refuses the host outright. An attempt that
   * lasted forty seconds was a transfer that went somewhere and was cut, which
   * is the same row on screen and a different fix in the code.
   */
  attemptMs: number[] | null;
  /**
   * The browser that reported the failure, and what it knew about its link.
   *
   * `userAgent` is taken from the report request's own header rather than from
   * the payload: it is the one fact about the client the server can observe for
   * itself, and a diagnostic that a client could misreport would be worth less
   * than the one it cannot. Everything else here is the Network Information API,
   * which only Chrome implements — so a null means "not offered", not "lost".
   */
  userAgent: string | null;
  connectionType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
  /** Who was uploading. The admin panel already knows every creator id. */
  creatorId: string;
}

/**
 * Record one failed upload. Never throws.
 *
 * The log line comes first and is written even when the list write fails: the
 * provider's log is the copy that outlives both the cache entry and this
 * deployment, and it costs nothing.
 */
export async function recordUploadFailure(
  failure: Omit<UploadFailure, "at">
): Promise<UploadFailure> {
  const entry: UploadFailure = { at: new Date().toISOString(), ...failure };

  console.error(
    `[Upload Failure] ${entry.code}` +
      // Right beside the code, because it is what turns "NETWORK" into a cause.
      `${entry.reason ? ` (${entry.reason})` : ""}` +
      `${entry.stage ? ` at ${entry.stage}` : ""}` +
      `${entry.status !== null ? ` · HTTP ${entry.status}` : ""}` +
      `${typeof entry.chunkIndex === "number" ? ` · chunk ${entry.chunkIndex}` : ""}` +
      `${typeof entry.retryCount === "number" ? ` · retry ${entry.retryCount}` : ""}` +
      // The shape of the attempts, which is what separates a slow link from a
      // refused one. Written even when the numbers are tiny: "1ms, 2ms" is the
      // whole diagnosis, and it reads as noise only until you need it.
      `${entry.attemptMs?.length ? ` · attempts ${entry.attemptMs.map((ms) => `${ms}ms`).join(", ")}` : ""}` +
      `${entry.connectionType ? ` · on ${entry.connectionType}` : ""}` +
      `${typeof entry.downlinkMbps === "number" ? ` · ${entry.downlinkMbps} Mbps down` : ""}` +
      `${typeof entry.rttMs === "number" ? ` · ${entry.rttMs} ms rtt` : ""}` +
      `${entry.userAgent ? ` · ${entry.userAgent}` : ""}` +
      ` · creator ${entry.creatorId}` +
      `${entry.fileName ? ` · ${entry.fileName}` : ""}` +
      `${entry.fileSize !== null ? ` (${(entry.fileSize / 1024 / 1024).toFixed(1)} MB)` : ""}` +
      // The number that says whether the request was ever sent. On a chunk that
      // died at zero the browser never put a byte on the wire, which no other
      // field in the entry can say.
      `${typeof entry.bytesSent === "number" && typeof entry.bytesTotal === "number" ? ` · died at ${(entry.bytesSent / 1024 / 1024).toFixed(1)} of ${(entry.bytesTotal / 1024 / 1024).toFixed(1)} MB` : ""}` +
      `${entry.bunnyVideoId ? ` · slot ${entry.bunnyVideoId}` : ""}` +
      `\n                 ${entry.message}` +
      (entry.providerBody ? `\n                 Bunny said: ${entry.providerBody}` : "")
  );

  // Deliberately OUTSIDE the log call above and inside its own guard: the line is
  // the copy that outlives both the cache entry and this deployment, so it is
  // written unconditionally, while the list is best-effort.
  try {
    const existing = await cacheGet<UploadFailure[]>(FAILURES_KEY);
    const list = Array.isArray(existing) ? existing : [];
    await cacheSet(FAILURES_KEY, [entry, ...list].slice(0, MAX_KEPT), TTL_SECONDS);
  } catch {
    // cacheGet/cacheSet already swallow their own failures (lib/redis.ts) — this
    // is the belt to their braces, so "never throws" is true by construction
    // rather than by assumption about another module's internals.
  }

  return entry;
}

/** Recent failures, newest first. Empty when the cache cannot be read. */
export async function listUploadFailures(): Promise<UploadFailure[]> {
  let stored: UploadFailure[] | null;
  try {
    stored = await cacheGet<UploadFailure[]>(FAILURES_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  // Anything written by an older build, or by hand, is still rendered as a row
  // — but never trusted as a shape.
  return (
    stored
      .filter(
        (entry): entry is UploadFailure =>
          !!entry && typeof entry === "object" && typeof entry.at === "string"
      )
      // The byte counts were added after these entries existed, so a row written
      // by an older build has no such field at all — and a MISSING field is not
      // `null`. Without this the panel's own `!== null` guard passes, the
      // arithmetic runs on `undefined`, and a real incident renders as "Died
      // after NaN MB of NaN MB". Normalised here so the shape the panel reads
      // matches the shape its type promises.
      .map((entry) => ({
        ...entry,
        bytesSent: typeof entry.bytesSent === "number" ? entry.bytesSent : null,
        bytesTotal: typeof entry.bytesTotal === "number" ? entry.bytesTotal : null,
        // Same rule for the fields added after the first entries were written:
        // absent is not null, and a missing number that reaches arithmetic
        // prints as NaN on the one screen meant to be read during an incident.
        reason: typeof entry.reason === "string" ? entry.reason : null,
        offset: typeof entry.offset === "number" ? entry.offset : null,
        chunkIndex: typeof entry.chunkIndex === "number" ? entry.chunkIndex : null,
        retryCount: typeof entry.retryCount === "number" ? entry.retryCount : null,
        // Same rule again for the fields added after THOSE: an entry written
        // before them has no `attemptMs` at all, and the panel maps over the
        // array — `undefined.map` is a crash on the one screen that exists to
        // explain an incident.
        attemptMs: Array.isArray(entry.attemptMs)
          ? entry.attemptMs.filter((ms): ms is number => typeof ms === "number")
          : null,
        userAgent: typeof entry.userAgent === "string" ? entry.userAgent : null,
        connectionType: typeof entry.connectionType === "string" ? entry.connectionType : null,
        downlinkMbps: typeof entry.downlinkMbps === "number" ? entry.downlinkMbps : null,
        rttMs: typeof entry.rttMs === "number" ? entry.rttMs : null,
      }))
  );
}
