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
// Three intros exist, in preference order:
//
//   "trailer"    a separate short clip the CREATOR uploaded. Chosen, branded,
//                played through the HLS player with an end card.
//   "montage"    four ~4 second pieces cut from the scene itself (opening,
//                middle, further in, end) and stitched into one manifest by
//                /api/videos/[id]/intro-clip — real motion, the shape every
//                streaming site uses. Safe to hand to a non-buyer because every
//                segment URL in it is signed for that one file (see
//                lib/intro-clip.ts), so it cannot be widened into the scene.
//   "animation"  Bunny's own generated animated preview: a silent, low
//                resolution webp. The floor beneath the floor, for a library
//                with previews on but no usable playlist.
//
// None of the three is the scene: each is a separate asset (or, for the montage,
// sixteen seconds of one), so none can be used to watch it.
// =============================================================================

export type IntroMedium = "trailer" | "montage" | "animation" | "none";

export interface IntroTrailerInput {
  /** The viewer holds a live entitlement (free, purchase, subscription, owner). */
  canPlayFull: boolean;
  /** Bunny is still encoding, or the encode failed — there is nothing to play. */
  notPlayable: boolean;
  /** The creator's separate trailer clip, if one is attached and playable. */
  teaserUrl: string | null | undefined;
  /**
   * The in-app URL of the stitched intro clip (`/api/videos/<id>/intro-clip`).
   * Only ever sent for a viewer with no entitlement and no trailer.
   */
  clipUrl?: string | null;
  /**
   * Set once the clip has failed to play in the browser — the manifest did not
   * load, or the segments were refused. The page then drops to the animation
   * rather than showing a player that will never start.
   */
  montageFailed?: boolean;
  /**
   * Bunny's generated animated preview, already signed. The fallback when the
   * clip cannot be built or played.
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
 * creator's trailer wins, then the stitched clip, then Bunny's webp animation.
 */
export function pickIntroMedium({
  canPlayFull,
  notPlayable,
  teaserUrl,
  clipUrl,
  montageFailed,
  previewAnimationUrl,
  animationFailed,
  price,
}: IntroTrailerInput): IntroMedium {
  if (canPlayFull || notPlayable || price <= 0) return "none";
  if (teaserUrl) return "trailer";
  if (clipUrl && !montageFailed) return "montage";
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
