// =============================================================================
// GENHUB - Telling the server that a video upload died
//
// The byte transfer happens in the creator's browser and goes STRAIGHT to Bunny,
// so the application server never sees it — and the video row is only created
// after the transfer finishes. A failed upload therefore leaves nothing at all:
// no row to look at, no log line, no counter, and a toast that is gone the
// moment the creator closes the tab. That is how a live library ended up with
// fourteen orphaned slots against nine rows while the only description of the
// fault in existence was "video zinafail inaandika connection interrupted".
//
// The transport already knows why it gave up — the reason, the offset, the
// attempt timings — and this is the one place that knowledge is sent somewhere
// it can outlive the tab.
//
// TWO RULES, both learned the hard way:
//
//   1. Reporting must never throw and must never block. The creator is already
//      looking at a failure; turning the report into a second one on screen
//      would be a worse outcome than a missing row in a list.
//   2. The payload carries FACTS the browser measured, not conclusions. Which
//      physical fault it was, how many bytes Bunny had confirmed, how long each
//      attempt lasted — the fields that tell a phone that lost signal apart from
//      a socket a carrier reset, which are the same toast on screen.
// =============================================================================

import type { VideoUploadError, VideoUploadSession } from "@/lib/video-upload";

/**
 * What a browser will tell a page about its own link, when it will tell it at
 * all. Only Chromium implements this, so every field is optional and a missing
 * one means "not offered" — never "no connection".
 */
interface NetworkInformation {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

function networkInformation(): NetworkInformation | null {
  try {
    const nav = navigator as Navigator & { connection?: NetworkInformation };
    return nav.connection ?? null;
  } catch {
    return null;
  }
}

export interface UploadFailureReport {
  code: string;
  stage: string | null;
  status: number | null;
  message: string;
  providerBody: string | null;
  reason: string | null;
  bunnyVideoId: string | null;
  fileName: string | null;
  fileSize: number | null;
  bytesSent: number | null;
  bytesTotal: number | null;
  offset: number | null;
  chunkIndex: number | null;
  retryCount: number | null;
  attemptMs: number[] | null;
  connectionType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
}

/**
 * Turn a thrown error into the record that gets stored.
 *
 * Every field is read from the error rather than inferred from its message. The
 * banner the creator saw is a sentence built for them; the shape of the failure
 * is a set of numbers, and a reader who has to parse the sentence to recover the
 * numbers is one wording change away from losing the diagnosis.
 */
export function buildUploadFailureReport(
  error: unknown,
  context: { session?: VideoUploadSession | null; file?: File | null; kind?: "main" | "teaser" } = {}
): UploadFailureReport {
  const failure = error as Partial<VideoUploadError>;
  const network = networkInformation();
  const code = typeof failure?.code === "string" ? failure.code : "UNKNOWN";

  return {
    code,
    stage: failure?.stage ?? null,
    status: typeof failure?.status === "number" ? failure.status : null,
    // The toast, clipped to the column's bound. Prefixed so a row is readable
    // without knowing which form the creator was standing on.
    message: `${context.kind === "teaser" ? "Teaser: " : ""}${
      typeof failure?.message === "string" && failure.message
        ? failure.message
        : "The video upload failed."
    }`.slice(0, 300),
    providerBody: failure?.providerBody ?? null,
    reason: failure?.reason ?? null,
    bunnyVideoId: context.session?.videoId ?? null,
    fileName: context.file?.name ?? null,
    fileSize: context.file?.size ?? null,
    bytesSent: typeof failure?.bytesSent === "number" ? failure.bytesSent : null,
    bytesTotal: typeof failure?.bytesTotal === "number" ? failure.bytesTotal : context.file?.size ?? null,
    offset: typeof failure?.offset === "number" ? failure.offset : null,
    chunkIndex: typeof failure?.chunkIndex === "number" ? failure.chunkIndex : null,
    retryCount: typeof failure?.retryCount === "number" ? failure.retryCount : null,
    attemptMs: Array.isArray(failure?.attemptMs) ? failure.attemptMs.slice(0, 20) : null,
    connectionType: network?.effectiveType ?? null,
    downlinkMbps: typeof network?.downlink === "number" ? network.downlink : null,
    rttMs: typeof network?.rtt === "number" ? network.rtt : null,
  };
}

/**
 * Send it, and do not care whether it arrives.
 *
 * `keepalive` is the point: the most common way a creator reacts to a failed
 * upload is to close the page, and a report that dies with the tab is a report
 * that was never written. The server reads the creator, the browser and the
 * origin from the request itself, so this body carries only what only the
 * browser knows.
 */
export function reportUploadFailure(
  error: unknown,
  context: { session?: VideoUploadSession | null; file?: File | null; kind?: "main" | "teaser" } = {}
): void {
  try {
    const report = buildUploadFailureReport(error, context);
    void fetch("/api/videos/upload-failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Nothing a reporter of failures is allowed to do about a failure to report.
  }
}
