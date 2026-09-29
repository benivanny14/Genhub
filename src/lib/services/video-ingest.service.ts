// =============================================================================
// GENHUB - Move a finished upload out of the bucket and into Bunny
//
// The upload ends in R2, not in Bunny, so something has to close the gap before
// the encode lifecycle has anything to watch. This is that step, and it is a
// separate call from the request that creates the post on purpose: a video is
// tens of megabytes moving between two providers, and folding that into the
// request that writes the row would make the creator's "publish" as long as the
// slowest network hop in the pipeline — and would leave a half-written post
// behind when it timed out.
//
// WHY NOT BUNNY'S OWN FETCH API. It is the obvious tool and it does not fit:
// `POST /library/{id}/videos/fetch` creates a video object of its own and its
// documented (and observed) response carries no guid —
//
//     { "success": true, "message": "OK", "statusCode": 200 }
//
// — so it cannot fill the slot that was reserved for this creator's post, and a
// RETRY creates a second video with a second guid holding the same bytes. Every
// other part of Genhub is keyed on the Bunny guid, so a guid that has to be
// hunted for after the fact is a guid that can be attached to the wrong post.
// worker/video-ingest performs the move instead, into the reserved id, where a
// retry is idempotent.
//
// WHAT A FAILURE MEANS. Every outcome below is decided by something an operator
// can act on: the bucket or the ingest being unconfigured, Bunny refusing the
// library key, the object never having arrived, or the ingest being unreachable.
// None of them are reported as "connection dropped", which is the sentence this
// whole thread of work exists to stop saying wrongly.
// =============================================================================

import config from "@/lib/config";
import { signVideoIngestToken, videoIngestUrl } from "@/lib/video-ingest-token";
import { videoObjectKey } from "@/lib/upload-target";
import { isR2Configured } from "@/lib/r2-sign";

/**
 * How long one ingest is given.
 *
 * This is the caller's patience, not the transfer's limit: the Worker runs until
 * Bunny answers, and if this route is cut short the ingest it started may still
 * be running. That is safe, because a retry writes the same file into the same
 * reserved slot.
 *
 * IT MUST STAY UNDER THE ROUTE'S OWN BUDGET. `/api/videos/ingest` declares
 * `maxDuration = 60`, and this was 60_000 as well — so the two fired at the same
 * instant and the function was killed exactly when the abort was about to
 * produce a sentence. A killed function answers the browser with nothing at all,
 * which the upload page can only report as "Network error while preparing the
 * video": the one message that names no cause, on the one step where the cause
 * is knowable. The headroom below is what lets the abort win that race, so the
 * creator gets this file's real reason (describeIngestFailure) instead.
 *
 * Exported so the relationship is asserted rather than remembered — see
 * tests/video-ingest.test.ts.
 */
export const INGEST_TIMEOUT_MS = 55_000;

export type IngestFailureReason =
  | "not-configured"
  | "refused"
  | "not-uploaded"
  | "unreachable";

export interface IngestOutcome {
  ok: boolean;
  reason?: IngestFailureReason;
  /** Whatever the far side said, trimmed — for the log and the admin card. */
  detail?: string;
}

/** What to tell the creator, in the words they need to act on. */
export function describeIngestFailure(outcome: IngestOutcome): string {
  switch (outcome.reason) {
    case "not-configured":
      // Deliberately not "no bucket": what is missing is the pair — the bucket
      // and the Worker that moves the file out of it — and naming only one of
      // them sends whoever reads this looking in the wrong place.
      return "This deployment's upload storage is not configured, so the file cannot be prepared. Tell support.";
    case "not-uploaded":
      return "The upload did not reach storage. Please upload the video again.";
    case "refused":
      return `The video service refused the file (${outcome.detail || "no detail"}). Please try again.`;
    default:
      return "The upload finished but could not be handed to the video service. Please try again.";
  }
}

/**
 * Hand one uploaded object to Bunny, into the slot reserved for this video id.
 *
 * `now` is passed in so the expiry rule can be tested without waiting for it.
 */
export async function ingestUploadedVideo(
  videoId: string,
  now: Date = new Date()
): Promise<IngestOutcome> {
  const { url, secret, urlTtlSeconds } = config.videoIngest;

  // Both halves are needed and neither is inferred: without R2 there are no
  // bytes to move, and without the Worker there is nobody to do the moving.
  if (!isR2Configured(config.r2) || !url || !secret) {
    return { ok: false, reason: "not-configured" };
  }

  const key = videoObjectKey(videoId);
  const expiresAt = Math.floor(now.getTime() / 1000) + Math.max(60, urlTtlSeconds);
  const token = await signVideoIngestToken(secret, key, videoId, expiresAt);
  const endpoint = videoIngestUrl({ baseUrl: url, key, videoId, expiresAt, token });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });

    const text = await response.text().catch(() => "");

    if (response.ok) return { ok: true, detail: text.slice(0, 200) };

    if (response.status === 404) {
      return { ok: false, reason: "not-uploaded", detail: text.slice(0, 300) };
    }

    // 401 from the Worker means the token this server just signed did not verify
    // — a secret mismatch between the two runtimes, which is worth its own
    // sentence because it is a deployment mistake, not a creator's problem.
    if (response.status === 401) {
      return {
        ok: false,
        reason: "refused",
        detail: "the ingest rejected our token (VIDEO_INGEST_SECRET mismatch)",
      };
    }

    return { ok: false, reason: "refused", detail: `HTTP ${response.status} ${text.slice(0, 300)}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    return { ok: false, reason: "unreachable", detail: name };
  }
}
