// =============================================================================
// GENHUB - Failed video uploads: the record a failed upload never had
//
// The byte transfer happens in the creator's browser and goes STRAIGHT to Bunny,
// so the server never sees it — and the video row is only created after the
// transfer finishes. A failed upload therefore leaves nothing anywhere: no row
// to look at, no log line, no counter. The creator gets a toast naming a fault,
// and by the time anybody asks what it said, the tab is closed.
//
// So the browser reports the failure through /api/videos/upload-failure and it
// lands in two places on purpose:
//
//   1. console.error — the hosting provider's log. Durable, searchable, and the
//      half that survives a cache outage.
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

import { cacheDel, cacheGet, cacheSet } from "@/lib/redis";
import { formatUploadBytes } from "@/lib/upload-failure-reading";

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
  /** VideoUploadError.code — NETWORK / HTTP / EXPIRED / CONFLICT / … */
  code: string;
  /**
   * Which request died: the session POST, or one chunk PATCH. `put` is kept in
   * the type because records written by the whole-file uploader are still stored
   * and a type that rejected them would make reading the history a compile
   * error rather than a history lesson.
   */
  stage: "reserve" | "chunk" | "put" | null;
  /** Bunny's HTTP status, or null when nothing answered. */
  status: number | null;
  /** What the creator was shown. */
  message: string;
  /**
   * The raw words that name the cause: Bunny's own response body, verbatim, when
   * there was a response — and the browser's own error (its `name` and message)
   * when the failure never left the device. Both belong here because they are
   * the same thing: the evidence nobody paraphrased.
   */
  providerBody: string | null;
  /**
   * Which physical fault it was: offline, reset, stall, timeout, provider,
   * cancelled or preflight.
   *
   * The code is a verdict and this is the cause, and one is often not enough.
   * `NETWORK` with a null status covers a phone that lost signal, a proxy that
   * reset the socket, and an upload the page's own timer aborted — three
   * problems with three different answers, and before this field the record
   * could not say which one had happened.
   */
  reason: string | null;
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
   * both were the single word "NETWORK".
   */
  bytesSent: number | null;
  bytesTotal: number | null;
  /** The offset the failing request started at — a floor under `bytesSent`. */
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
   * lasted forty seconds was a transfer that went somewhere and was cut, which is
   * the same row on screen and a different fix in the code.
   */
  attemptMs: number[] | null;
  /**
   * The browser that reported the failure, and what it knew about its link.
   *
   * `userAgent` is taken from the report request's own header rather than from
   * the payload: it is the one fact about the client the server can observe for
   * itself, and a diagnostic a client could misreport would be worth less than
   * the one it cannot. Everything else here is the Network Information API,
   * which only Chrome implements — so a null means "not offered", not "lost".
   */
  userAgent: string | null;
  /**
   * The ADDRESS the page was served from, taken from the report's own Origin
   * header — observed by the server, like `userAgent`, and for the same reason.
   *
   * A page loaded from an origin the storage policy does not name is refused at
   * the preflight, so the request is never sent and every other field of the
   * record looks exactly like a phone that lost its signal.
   */
  origin: string | null;
  connectionType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
  /** Who was uploading. The admin panel already knows every creator id. */
  creatorId: string;
}

/** Everything except `at`, which the server stamps itself. */
export type UploadFailureInput = Omit<UploadFailure, "at">;

/**
 * Record one failed upload. Never throws.
 *
 * The log line comes first and is written even when the list write fails: the
 * provider's log is the copy that outlives both the cache entry and this
 * deployment, and it costs nothing.
 */
export async function recordUploadFailure(failure: UploadFailureInput): Promise<UploadFailure> {
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
      `${entry.origin ? ` · from ${entry.origin}` : ""}` +
      `${entry.userAgent ? ` · ${entry.userAgent}` : ""}` +
      ` · creator ${entry.creatorId}` +
      `${entry.fileName ? ` · ${entry.fileName}` : ""}` +
      `${entry.fileSize !== null ? ` (${formatUploadBytes(entry.fileSize)})` : ""}` +
      // The number that says whether the request was ever sent.
      `${typeof entry.bytesSent === "number" && typeof entry.bytesTotal === "number" ? ` · died at ${formatUploadBytes(entry.bytesSent)} of ${formatUploadBytes(entry.bytesTotal)}` : ""}` +
      `${entry.bunnyVideoId ? ` · slot ${entry.bunnyVideoId}` : ""}` +
      `\n                 ${entry.message}` +
      (entry.providerBody ? `\n                 Provider said: ${entry.providerBody}` : "")
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

/**
 * Recent failures, newest first. Empty when the cache cannot be read.
 *
 * Sorted rather than trusted: the list is written by prepending, so it is
 * already newest-first, but a record that arrived twice or a list read after a
 * manual edit would otherwise be shown out of order and read as a pattern that
 * does not exist.
 */
export async function listUploadFailures(): Promise<UploadFailure[]> {
  let stored: UploadFailure[] | null;
  try {
    stored = await cacheGet<UploadFailure[]>(FAILURES_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  return [...stored].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_KEPT);
}

/** Forget every stored failure. Used by the admin panel after a fix is confirmed. */
export async function clearUploadFailures(): Promise<void> {
  await cacheDel(FAILURES_KEY);
}
