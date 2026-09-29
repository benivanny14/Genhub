// =============================================================================
// GENHUB - What the creator's OWN phone said it could reach
//
// The diagnostic page (/creator/upload-check) runs the two requests an upload
// makes — a signed write of one small object and a signed write of PART ONE of a
// real multipart upload — from the device that is failing, and prints what
// happened to each. That page is the only place the answer exists: the browser
// tells the page nothing about why a cross-origin request failed, and the server
// never sees the request at all.
//
// WHICH IS WHY THE ANSWER IS STORED. A verdict that lives only on a phone screen
// is a verdict somebody has to be sent a screenshot of, and the person who can
// act on it is the one sitting at /admin. Measured on 2026-09-29: a phone that
// had completed a 192 MB multipart upload an hour earlier had every later part
// PUT die in under a second with ZERO bytes acknowledged, four times, and the
// only record of it in the system was the sentence "the connection dropped" —
// which is also what a phone with no signal produces. The creator had to be asked
// to open a page and describe it. This is the half that removes the describing.
//
// STORED IN TWO SHAPES, ON PURPOSE:
//
//   1. console.info — the hosting provider's log. Durable, searchable, and the
//      half that survives a Redis outage. The reading sentence goes into it, so a
//      single log line says what the device could and could not do.
//   2. A bounded list in the cache, newest first, read by the admin panel. A log
//      line cannot be seen from the screen an operator is already looking at.
//
// AND ALSO UNDER THE CREATOR'S OWN KEY, which is the answer to the narrower
// question somebody asks with a creator on the phone: "what did YOUR phone say
// last time?". The list below is deduplicated by creator for the mirror image of
// the same reason — a creator who pressed the button four times while somebody
// watched must not push three other creators off the screen.
//
// STORAGE: the cache helpers degrade to a skipped write when Redis is
// unreachable (lib/redis.ts) and never throw, which is the right failure mode
// here — a check that cannot be recorded must not become a second problem on a
// page whose only job is to explain the first one.
// =============================================================================

import { cacheGet, cacheSet } from "@/lib/redis";
import { describeProbePair } from "@/lib/upload-diagnostics";

/** The list the admin panel reads. One key, so it cannot grow without bound. */
const CHECKS_KEY = "bunny:upload:checks";

/**
 * How many checks are kept.
 *
 * Enough that a fleet of creators each reporting in one evening is still
 * readable, and small enough that the whole list is one cheap read the admin page
 * makes on every visit — the same trade as the failure records.
 */
const MAX_KEPT = 25;

/** Long enough that "it worked yesterday and not today" is still answerable. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** The per-creator copy, kept for as long as somebody might still be on the
 *  phone asking about it. Kept in step with nothing: it is one small key. */
const PER_CREATOR_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * What one probe of the device produced.
 *
 * `status` is null when nothing answered, which is the case this whole page
 * exists for — and the one where `error` carries the browser's own error name.
 * `etag` is recorded for a write because it is the only value that proves the
 * write HAPPENED rather than the request merely being answered.
 */
export interface CheckWriteProbe {
  ok: boolean;
  status: number | null;
  ms: number;
  etag?: string | null;
  error?: string;
}

/** Whether the device could reach the storage host at all, and how that went. */
export interface CheckReachProbe {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface UploadCheckRecord {
  /** When we heard it, ISO. */
  at: string;
  /** Who ran the check. */
  creatorId: string;
  /**
   * The address the page was open on, observed from the report's own Origin
   * header — the same field, read the same way, as the failure records, and for
   * the same reason: a refused part PUT and a phone with no signal are
   * indistinguishable without it.
   */
  origin?: string | null;
  /** The browser that ran the check, observed from the request's own header. */
  userAgent?: string | null;
  /**
   * What the phone said about its own link. Only Chrome implements the Network
   * Information API, so null means "not offered" rather than "nothing wrong" —
   * which is why the two probes below, not these, are the verdict.
   */
  connectionType?: string | null;
  downlinkMbps?: number | null;
  rttMs?: number | null;
  /** Did the device reach the bucket's host at all? */
  reach: CheckReachProbe | null;
  /** A real signed write of one whole small object. */
  whole: CheckWriteProbe | null;
  /** A real signed write of part 1 of a real multipart upload. */
  part: CheckWriteProbe | null;
}

/** One probe, rendered for a log line: the outcome, how long it took, and why. */
function describeProbe(label: string, probe: CheckWriteProbe | null): string {
  if (!probe) return `${label}: not run`;

  const how = probe.status !== null ? `HTTP ${probe.status}` : (probe.error ?? "no answer");
  return `${label}: ${probe.ok ? "ok" : "refused"} (${how}) in ${probe.ms} ms`;
}

/**
 * Record one check. Never throws.
 *
 * The log line comes first and is written even when the list write fails, exactly
 * as the failure records do: the provider's log outlives both the cache entry and
 * this deployment.
 */
export async function recordUploadCheck(
  check: Omit<UploadCheckRecord, "at">
): Promise<UploadCheckRecord> {
  const entry: UploadCheckRecord = { at: new Date().toISOString(), ...check };

  // The READING, not only the raw numbers. "Refused (TypeError) after 45 ms" is
  // evidence; what it means — that this device could not reach the host, or that
  // the bucket would not accept a part from this page — is the sentence somebody
  // has to be able to act on, and it is the same function the page prints.
  const readings = [
    describeProbe("whole object", entry.whole),
    describeProbe("part 1", entry.part),
    entry.reach ? `reach: ${entry.reach.ok ? "ok" : "failed"} in ${entry.reach.ms} ms` : "reach: not run",
    describeProbePair(entry.reach, entry.part, "storage host, for a part"),
  ];

  console.info(
    `[Upload Check] creator ${entry.creatorId}` +
      `${entry.origin ? ` · from ${entry.origin}` : ""}` +
      `${entry.connectionType ? ` · on ${entry.connectionType}` : ""}` +
      `${typeof entry.downlinkMbps === "number" ? ` · ${entry.downlinkMbps} Mbps down` : ""}` +
      `${typeof entry.rttMs === "number" ? ` · ${entry.rttMs} ms rtt` : ""}` +
      `${entry.userAgent ? ` · ${entry.userAgent}` : ""}` +
      readings.map((line) => `\n                 ${line}`).join("")
  );

  // Best-effort, and guarded twice: cacheGet/cacheSet already swallow their own
  // failures, and a check that cannot be recorded must not fail the page.
  try {
    const existing = await cacheGet<UploadCheckRecord[]>(CHECKS_KEY);
    const list = Array.isArray(existing) ? existing : [];
    await cacheSet(CHECKS_KEY, [entry, ...list].slice(0, MAX_KEPT), TTL_SECONDS);

    // The creator's own copy, under the key the route has always written. Kept
    // because it answers a different question ("what about THIS creator?") with
    // one read instead of a scan, and it survives the list's cap.
    await cacheSet(`upload:check:${entry.creatorId}`, entry, PER_CREATOR_TTL_SECONDS);
  } catch {
    // Nothing to do: the log line above already carries the verdict.
  }

  return entry;
}

/** One probe as the panel can render it: absent stays absent, never `null`. */
function normalizeWrite(value: unknown): CheckWriteProbe | null {
  if (!value || typeof value !== "object") return null;
  const probe = value as Partial<CheckWriteProbe>;
  if (typeof probe.ok !== "boolean" || typeof probe.ms !== "number") return null;

  return {
    ok: probe.ok,
    // Absent is not a number, and a status that is not a number would render as
    // "HTTP undefined" on the one screen meant to be read during an incident.
    status: typeof probe.status === "number" ? probe.status : null,
    ms: probe.ms,
    etag: typeof probe.etag === "string" ? probe.etag : null,
    error: typeof probe.error === "string" ? probe.error : undefined,
  };
}

function normalizeReach(value: unknown): CheckReachProbe | null {
  if (!value || typeof value !== "object") return null;
  const probe = value as Partial<CheckReachProbe>;
  if (typeof probe.ok !== "boolean" || typeof probe.ms !== "number") return null;

  return {
    ok: probe.ok,
    ms: probe.ms,
    error: typeof probe.error === "string" ? probe.error : undefined,
  };
}

/**
 * The most recent check per creator, newest first. Empty when the cache cannot
 * be read.
 *
 * DEDUPLICATED BY CREATOR, because that is the question this is read to answer:
 * "which creator's phone cannot reach the bucket?" — asked once per creator, not
 * once per button press. Everything is normalised on the way out so that a record
 * written by an older build (or by hand) renders as a row rather than a crash.
 */
export async function listUploadChecks(): Promise<UploadCheckRecord[]> {
  let stored: UploadCheckRecord[] | null;
  try {
    stored = await cacheGet<UploadCheckRecord[]>(CHECKS_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  const seen = new Set<string>();
  const checks: UploadCheckRecord[] = [];

  for (const entry of stored) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.at !== "string" || typeof entry.creatorId !== "string") continue;
    // The list is newest-first, so the first row for a creator is their latest.
    if (seen.has(entry.creatorId)) continue;
    seen.add(entry.creatorId);

    checks.push({
      ...entry,
      origin: typeof entry.origin === "string" ? entry.origin : null,
      userAgent: typeof entry.userAgent === "string" ? entry.userAgent : null,
      connectionType: typeof entry.connectionType === "string" ? entry.connectionType : null,
      downlinkMbps: typeof entry.downlinkMbps === "number" ? entry.downlinkMbps : null,
      rttMs: typeof entry.rttMs === "number" ? entry.rttMs : null,
      reach: normalizeReach(entry.reach),
      whole: normalizeWrite(entry.whole),
      part: normalizeWrite(entry.part),
    });
  }

  return checks;
}
