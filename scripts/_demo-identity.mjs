// =============================================================================
// GENHUB - What counts as demo content
//
// Shared by scripts/demo-wipe.mjs (which deletes it) and by
// src/tests/demo-identity.test.ts (which guards the rule). It lives in its own
// file because this predicate is the safety-critical part: match too little and
// the wipe leaves rows behind that keep appearing on the homepage; match too
// much and it deletes a real creator's work.
//
// POST /api/demo/seed writes every row it owns under an id starting with
// `demo-`, and every account it owns at `@demo.genhub.local`. Rows it creates
// through a relation instead of by id — gallery images, watch progress, creator
// balances, likes — carry generated ids, so they are found by the video or user
// they hang off, never by matching their own id. That is why the wipe resolves
// those from the two id sets rather than by pattern.
//
// Prisma's cuid() starts with "c", and nothing the application creates begins
// with "demo-", so neither pattern can collide with real data.
// =============================================================================

export const DEMO_ID_PREFIX = "demo-";
export const DEMO_EMAIL_DOMAIN = "demo.genhub.local";

/** True for a row the seed created by explicit id. */
export const isDemoId = (id) =>
  typeof id === "string" && id.startsWith(DEMO_ID_PREFIX);

/** True for an account the seed created. */
export const isDemoEmail = (email) =>
  typeof email === "string" && email.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);

/**
 * Why a row was classified as demo, for reports a person reads.
 * Returns null when it is not demo content at all.
 */
export function demoReason(row) {
  if (!row) return null;
  if (isDemoEmail(row.email)) return `email @${DEMO_EMAIL_DOMAIN}`;
  if (isDemoId(row.id)) return `id starts with "${DEMO_ID_PREFIX}"`;
  return null;
}

/** True for a fixed demo account, whatever it was given at creation. */
export const isDemoAccount = (row) =>
  Boolean(row) && (isDemoId(row.id) || isDemoEmail(row.email));

/**
 * Tables the wipe touches, children before parents.
 *
 * Relation order matters: `Transaction`, `PayoutRequest`, `PayMessage` and
 * `VideoReport` declare no `onDelete: Cascade`, so the database will refuse to
 * delete a user or video that still has one. Everything else in this list does
 * cascade, and is deleted explicitly anyway so the report can count it.
 */
export const WIPE_ORDER = [
  "galleryImage",
  "videoLike",
  "favorite",
  "watchProgress",
  "comment",
  "videoAccess",
  "videoReport",
  "videoEarning",
  "playlistItem",
  "transaction",
  "payMessage",
  "payoutRequest",
  "creatorSubscription",
  "creatorPost",
  "notification",
  "passwordReset",
  "kycVerification",
  "creatorProfile",
  "creatorBalance",
  "playlist",
  "coupon",
  "video",
  "user",
];
