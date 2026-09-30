// =============================================================================
// GENHUB - Verified badge
//
// The mark a verified creator carries beside their name, everywhere their name
// is drawn. Deliberately a filled seal with a white check in the middle — the
// shape Instagram, X and Facebook all use — rather than a thin outline glyph:
// an outline disappears against a busy cover photo, and this badge's whole job
// is to be found at a glance.
//
// The colour is gold/yellow (brand yellow), not the usual blue. On a dark video
// cover and beside a white name, a blue tick reads like every other account on
// the internet; the gold one is the platform's own and stands out immediately.
//
// One component, so the mark cannot drift between the card, the watch page, the
// creator list and search — which is exactly what happened when each screen
// drew its own `BadgeCheck` with its own tailwind colour.
// =============================================================================

import { cn } from "@/lib/utils";

export default function VerifiedBadge({
  className,
  size,
  title = "Verified creator",
}: {
  /** Tailwind sizing classes (`h-4 w-4`) when `size` is not given. */
  className?: string;
  /** Explicit pixel size. When omitted, the className controls the box. */
  size?: number;
  /** Accessible label; each screen can name what it is vouching for. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      <title>{title}</title>
      {/* The scalloped seal. A gold fill, with the check knocked out of it. */}
      <path
        fill="#FFC400"
        d="M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69l-3.61.82.34 3.69L1 12l2.44 2.79-.34 3.69 3.61.82L8.6 22.5l3.4-1.47 3.4 1.47 1.89-3.19 3.61-.82-.34-3.69L23 12z"
      />
      {/* The check, in white so it stays legible on the gold at any size. */}
      <path
        fill="#ffffff"
        d="M10.09 16.72l-3.8-3.81 1.48-1.48 2.32 2.33 5.85-5.87 1.48 1.48-7.33 7.35z"
      />
    </svg>
  );
}
