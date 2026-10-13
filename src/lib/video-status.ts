// =============================================================================
// GENHUB - "Can this be watched yet?" — one vocabulary, shared by API and UI
//
// New uploads are not published until Streamtape conversion finishes. This
// helper remains to interpret the stored status codes on legacy video rows.
//
// DERIVED, NEVER STORED. Convert legacy `encodingStatus` and `encodeProgress`
// values to the one status shape the API and client understand.
//
// ---------------------------------------------------------------- the numbers
// Legacy provider state numbers retained only to interpret archived rows:
//
//   3 Finished  · 4 Resolution finished (Bunny: the first means it can play)
//   5 Failed
//
// Anything else (0 Queued, 1 Processing, 2 Encoding, …) is still on its way.
//
// This module is pure because it is imported by client components.
// =============================================================================

/** 3 — encoding finished; the video is fully available. */
export const BUNNY_FINISHED = 3;
/** 4 — one resolution is done; Bunny: the first of these means it can play. */
export const BUNNY_RESOLUTION_FINISHED = 4;
/** 5 — Bunny failed the file (bad codec, corrupt upload, empty slot). */
export const BUNNY_FAILED = 5;

/**
 * The three states a post can be shown in.
 *
 * `FAILED` is not "still working" — it will never become playable, so it must
 * never be dressed up as one (a spinner over a file nothing is transcoding is
 * a lie the viewer waits on forever).
 */
export type VideoStatus = "PROCESSING" | "READY" | "FAILED";

/** What the badge says while the host transcodes. Bilingual, one string. */
export const PROCESSING_BADGE_LABEL = "Inachakatwa...";
/** The same thing in English, for the tooltip and the screen reader. */
export const PROCESSING_BADGE_TITLE = "Inachakatwa... (Processing)";

/**
 * The publication state a video is in, from Bunny's own numbers.
 *
 * `null`/`undefined` encodingStatus means "not tracked by Bunny at all" — the
 * side-loaded and demo rows seeded with `previewUrl`, plus every video created
 * before the lifecycle existed. Those play exactly as they always did, so they
 * are READY: treating them as processing would have hidden the whole
 * catalogue behind a badge nothing would ever clear.
 *
 * `encodeProgress >= 100` counts as finished alongside status 3 and 4, so one
 * field Bunny reports oddly cannot hold every upload back forever.
 */
export function videoStatus(
  encodingStatus: number | null | undefined,
  encodeProgress: number | null | undefined
): VideoStatus {
  if (encodingStatus === null || encodingStatus === undefined) return "READY";
  if (encodingStatus === BUNNY_FAILED) return "FAILED";
  if (
    encodingStatus === BUNNY_FINISHED ||
    encodingStatus === BUNNY_RESOLUTION_FINISHED ||
    Number(encodeProgress) >= 100
  ) {
    return "READY";
  }
  return "PROCESSING";
}

/** True while the post is visible but the video cannot be played yet. */
export function isProcessingStatus(status: VideoStatus | null | undefined): boolean {
  return status === "PROCESSING";
}

/**
 * How often a client re-asks about a video that is still processing.
 *
 * Bunny reports progress in whole percents and finishes in minutes, so a faster
 * tick would spend requests to learn nothing. This is also the ceiling on how
 * late the switch from the badge to the player can be.
 */
export const PROCESSING_POLL_MS = 8_000;

/**
 * How long a page keeps polling before it gives up and trusts the next load.
 *
 * A stuck encode (or an upload that never arrived) can sit in PROCESSING for
 * as long as the host takes to notice, and a tab left open overnight must not
 * keep asking. Twenty minutes is well past any real transcode at this library's
 * sizes; after it the page just stops, which is what a plain reload would have
 * done anyway.
 */
export const PROCESSING_POLL_MAX_MS = 20 * 60 * 1000;
