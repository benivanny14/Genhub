// =============================================================================
// GENHUB - "Can this be watched yet?" — one vocabulary, shared by API and UI
//
// Instagram-like publication: the POST exists the moment the bytes arrive at
// the video host, and the feed shows it right away — thumbnail, title, an
// "Inachakatwa..." badge — while the host still has to transcode it into
// playable renditions. Bunny accepts an upload seconds after it starts and
// answers 201, but it cannot serve a manifest for minutes afterwards, so
// "this post is live" and "this video can play" became two different facts.
//
// Everything that has to tell them apart reads them through here, which is
// what keeps the feed card, the watch page and the API from disagreeing about
// which state a video is in — the failure mode this codebase has hit before,
// twice, with Bunny's own status numbers.
//
// DERIVED, NEVER STORED. The database keeps Bunny's own numbers
// (`encodingStatus`, `encodeProgress`), the only fields Bunny can move by
// itself; a separate stored `status` column would be a second copy of the same
// truth, and one missed webhook would leave it permanently wrong — a post
// labelled "ready" that plays nothing, with nothing left to reconcile it
// against. `status` is what the API answers, what the client switches on, and
// what the database would say if it were asked.
//
// ---------------------------------------------------------------- the numbers
// Bunny numbers its states 0..10 and uses one list for the webhook body and
// for a video object's `status` field. The three that decide publication:
//
//   3 Finished  · 4 Resolution finished (Bunny: the first means it can play)
//   5 Failed
//
// Anything else (0 Queued, 1 Processing, 2 Encoding, …) is still on its way.
//
// This module is PURE — no prisma, no Bunny, no node:crypto — because it is
// imported by client components. See BUNNY_STATUS_LABELS in
// lib/services/video-encoding.service.ts for the full map; describeEncoding
// there is built on these functions, so there is exactly one rule.
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
