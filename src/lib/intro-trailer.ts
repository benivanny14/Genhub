// =============================================================================
// GENHUB - Intro trailer decision
//
// A viewer who is entitled to neither the scene nor a free copy must still be
// shown an INTRO — that is what entices the sale. This module decides which
// intro, if any, that viewer gets, and it lives here as a pure function rather
// than inside the video page for two reasons: the rule is load-bearing (getting
// it wrong either leaks the scene or shows a black void), and it is trivially
// unit-testable.
//
// Two intros exist, in preference order:
//
//   "trailer"    a separate short clip the CREATOR uploaded. Chosen, branded,
//                played through the HLS player with an end card.
//   "animation"  Bunny's own generated animated preview (a silent ~10s montage).
//                The automatic floor, so a paid scene with no upload still has
//                something moving to show instead of a black box.
//
// Neither is the scene: both are separate assets, so neither can be used to
// watch it.
// =============================================================================

export type IntroMedium = "trailer" | "animation" | "none";

export interface IntroTrailerInput {
  /** The viewer holds a live entitlement (free, purchase, subscription, owner). */
  canPlayFull: boolean;
  /** Bunny is still encoding, or the encode failed — there is nothing to play. */
  notPlayable: boolean;
  /** The creator's separate trailer clip, if one is attached and playable. */
  teaserUrl: string | null | undefined;
  /**
   * Bunny's generated animated preview, already signed. Only ever sent for a
   * viewer with no entitlement, and only when no trailer clip exists.
   */
  previewAnimationUrl?: string | null;
  /**
   * Set once the animation has failed to load in the browser (the library may
   * have previews switched off, in which case the URL answers 404). A broken
   * image must never be the thing standing where the intro should be.
   */
  animationFailed?: boolean;
  /** The scene's price. A free scene has no paywall to walk through. */
  price: number;
}

/**
 * Which intro to render for this viewer.
 *
 * Returns "none" when the viewer can already watch the scene (an intro would be
 * a downgrade), when the scene cannot play at all (there is no preview to build
 * either), or when it is free (there is nothing to unlock). Otherwise the
 * creator's trailer wins, and Bunny's animation is the fallback.
 */
export function pickIntroMedium({
  canPlayFull,
  notPlayable,
  teaserUrl,
  previewAnimationUrl,
  animationFailed,
  price,
}: IntroTrailerInput): IntroMedium {
  if (canPlayFull || notPlayable || price <= 0) return "none";
  if (teaserUrl) return "trailer";
  if (previewAnimationUrl && !animationFailed) return "animation";
  return "none";
}

/**
 * True when the viewer should see an intro of some kind.
 *
 * Kept as a named helper because several places ask only "is this viewer being
 * teased?" without caring which asset does it.
 */
export function hasIntro(input: IntroTrailerInput): boolean {
  return pickIntroMedium(input) !== "none";
}
