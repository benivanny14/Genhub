// =============================================================================
// GENHUB - Quality tiers as viewers know them
// =============================================================================
// Why the player cannot label a level `level.height + "p"`.
//
// hls.js reports a level's PIXEL SIZE from the manifest's RESOLUTION attribute,
// and this platform's catalogue is PORTRAIT: an upload that Bunny encodes as its
// `360p` rendition is 358x640, and its `240p` rendition is 198x352 (measured
// against the live library — tests/quality.test.ts pins those exact numbers from
// a real manifest). Height alone therefore offered viewers "640p" and "352p":
// numbers no other platform shows, for a video every other platform offers at
// 360p and 240p.
//
// The name a viewer recognises is the SHORTER side — 720p means 1280x720, and a
// 720x1280 clip is also "720p" — snapped to the standard ladder every encoder
// (Bunny included) actually encodes to. Encoders scale to even numbers rather
// than exact tiers, so 358 is 360p and 198 is 240p; the comparison is
// multiplicative, because quality tiers are ratios, not differences.
//
// The menu is also ordered BEST FIRST, the way YouTube, Netflix and Vimeo order
// theirs. hls.js sorts its own level array by ascending bitrate, so the raw list
// puts the worst rendition at the top of the menu; the level INDEX is kept
// alongside each entry because that index — not the menu position — is what
// `hls.currentLevel` has to be set to (see VideoPlayer's chooseQuality).
// =============================================================================

/** The ladder every mainstream encoder produces, smallest first. */
export const QUALITY_TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160] as const;

export interface QualityLevelLike {
  width?: number;
  height?: number;
  bitrate?: number;
}

/** One row of the quality menu: what to show, and what to set on hls.js. */
export interface QualityOption {
  /** Index into `hls.levels` — NOT the position in the menu. */
  index: number;
  /** The tier as a viewer reads it, e.g. "360p". */
  label: string;
}

/**
 * The tier name for one parsed level, e.g. `360p`.
 *
 * Falls back to `Level <n>` when the manifest said nothing about the picture's
 * size, because a menu row that says "undefinedp" is worse than an honest
 * placeholder.
 */
export function qualityTierLabel(level: QualityLevelLike, index: number): string {
  const width = Number(level?.width) || 0;
  const height = Number(level?.height) || 0;
  const shortSide = Math.min(width || height, height || width);
  if (!shortSide) return `Level ${index + 1}`;

  let best: number = QUALITY_TIERS[0];
  let bestDistance = Infinity;
  for (const tier of QUALITY_TIERS) {
    const distance = Math.abs(Math.log(shortSide / tier));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tier;
    }
  }
  return `${best}p`;
}

/**
 * The quality menu: every level, labelled and ordered best first.
 *
 * Ordering is by bitrate (what "better" actually means to the viewer, and what
 * hls.js itself sorts by) with the picture size as a tie-break, so two renditions
 * of the same height cannot shuffle between renders.
 */
export function buildQualityMenu(levels: QualityLevelLike[]): QualityOption[] {
  return (levels || [])
    .map((level, index) => ({
      index,
      label: qualityTierLabel(level, index),
      bitrate: Number(level?.bitrate) || 0,
      height: Math.max(Number(level?.height) || 0, Number(level?.width) || 0),
    }))
    .sort(
      (a, b) =>
        b.bitrate - a.bitrate || b.height - a.height || a.index - b.index
    )
    .map(({ index, label }) => ({ index, label }));
}

/** The label for one hls level index, or null when it is not in the menu. */
export function qualityLabelFor(
  options: QualityOption[],
  levelIndex: number
): string | null {
  return options.find((option) => option.index === levelIndex)?.label ?? null;
}
