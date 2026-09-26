// =============================================================================
// GENHUB - Intro trailer decision
//
// The video page shows a trailer + unlock offer instead of the full scene for a
// viewer who is entitled to neither. That decision is small but load-bearing —
// it must never turn on for a scene the viewer may already watch, and it must
// never turn on for a scene with nothing to play — so it lives here as a pure
// function and is unit-tested rather than buried in the component.
// =============================================================================

export interface IntroTrailerInput {
  /** The viewer holds a live entitlement (free, purchase, subscription, owner). */
  canPlayFull: boolean;
  /** Bunny is still encoding, or the encode failed — there is nothing to play. */
  notPlayable: boolean;
  /** The separate trailer clip the server handed out for a non-buyer. */
  teaserUrl: string | null | undefined;
  /** The scene's price. A free scene has no paywall to walk through. */
  price: number;
}

/**
 * True when the viewer should see the intro trailer with a paywall CTA.
 *
 * A free scene is excluded because there is nothing to unlock, a scene with no
 * trailer clip is excluded because we would rather show nothing than sign a
 * non-buyer into the whole video, and an unplayable scene is excluded because
 * there is no trailer to play yet either.
 */
export function shouldShowIntroTrailer({
  canPlayFull,
  notPlayable,
  teaserUrl,
  price,
}: IntroTrailerInput): boolean {
  return !canPlayFull && !notPlayable && !!teaserUrl && price > 0;
}
