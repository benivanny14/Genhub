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
  /** TusUploadError.code — EXPIRED / REJECTED / NETWORK / UNSUPPORTED / ABORTED. */
  code: string;
  /** Which request died: the reserve POST, or a chunk PATCH. */
  stage: "reserve" | "chunk" | null;
  /** Bunny's HTTP status, or null when nothing answered. */
  status: number | null;
  /** What the creator was shown. */
  message: string;
  /** Bunny's own response body, verbatim — the half that names the cause. */
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
      `${entry.stage ? ` at ${entry.stage}` : ""}` +
      `${entry.status !== null ? ` · HTTP ${entry.status}` : ""}` +
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
      }))
  );
}
