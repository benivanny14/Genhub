// =============================================================================
// GENHUB - The player's arithmetic, kept where it can be tested
// =============================================================================
// Everything in this file is a pure function over numbers, so the parts of the
// player that a viewer actually feels — how much has played, how much is
// buffered ahead, which key does what — are pinned by tests in a node process
// instead of being discovered on a phone. The component owns the pixels and the
// video element; the decisions live here.
//
// The three that were previously missing outright, and the reason each matters:
//
//   * SPEED. Every player a viewer has used offers 0.5×–2×; a scene somebody
//     wants to skim, or a creator they cannot understand at full tilt, was
//     simply not offered here.
//   * BUFFERED AHEAD. The progress bar drew only a thumb on a grey track, so it
//     said nothing about how far the picture was loaded — the one thing that
//     tells a viewer on a slow connection whether waiting will help.
//   * KEYBOARD. Space, the arrows, M and F are what a desktop viewer's hands
//     already know from every other site, and none of them did anything.
// =============================================================================

/** The speeds offered, slowest first. `1` is the scene as it was shot. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * A speed as the menu shows it.
 *
 * `1` is named rather than numbered: "Normal" is the label viewers look for to
 * put a video back the way it was, and "1×" reads like an arbitrary setting
 * among the others.
 */
export function rateLabel(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "Normal";
  if (Math.abs(rate - 1) < 0.001) return "Normal";
  // 1.25 -> "1.25x", 0.5 -> "0.5x" — trailing zeros trimmed so the chips line up.
  return `${String(Number(rate.toFixed(2)))}×`;
}

/**
 * How far through the scene the playhead is, as a percentage of the bar.
 *
 * Clamped, and 0 for anything that cannot be divided — a live or not-yet-loaded
 * element reports `duration: NaN`, and a bar whose width is `NaN%` disappears
 * entirely (which is how a broken bar looks like a missing feature).
 */
export function progressPercent(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (currentTime / duration) * 100));
}

/** The subset of `TimeRanges` this file needs, so a test can hand over a stub. */
export interface TimeRangesLike {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * The end of the range the playhead is inside, in seconds, or 0 when nothing
 * ahead of it is loaded.
 *
 * `video.buffered` is a list of disjoint ranges, not one number: after a seek,
 * the player can hold 0:00–1:20 and 40:00–41:00 with a hole between them, and
 * "how much is buffered" is the end of the range the playhead is IN — picking
 * `end(length - 1)` would draw the bar as fully loaded, which is worse than
 * drawing nothing because it promises what the connection has not delivered.
 */
export function bufferedEndAt(ranges: TimeRangesLike | null | undefined, currentTime: number): number {
  if (!ranges || !Number.isFinite(currentTime)) return 0;
  const count = Number(ranges.length) || 0;
  for (let index = 0; index < count; index++) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // A hair of tolerance: the playhead sits exactly on a range's end constantly
    // (buffering stops there), and an off-by-epsilon check would blink the
    // buffered bar in and out while the picture plays.
    if (currentTime >= start - 0.25 && currentTime <= end + 0.25) return end;
  }
  return 0;
}

/** What a key does, or null when the player has no business handling it. */
export type PlayerShortcut =
  | "toggle-play"
  | "seek-back"
  | "seek-forward"
  | "volume-up"
  | "volume-down"
  | "toggle-mute"
  | "toggle-fullscreen";

/**
 * The action a keypress means, using the same keys every other player uses.
 *
 * Returns null for everything else, INCLUDING any key pressed with Ctrl/Alt/Meta
 * — Ctrl+S, Cmd+F and the like belong to the browser, and a player that eats them
 * feels broken in a way the viewer cannot explain. (`k`, `j` and `l` are the
 * YouTube shortcuts, included because they cost nothing and are what some hands
 * already reach for.)
 */
export function playerShortcutFor(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
): PlayerShortcut | null {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return null;
  switch (key) {
    case " ":
    case "Spacebar": // legacy key name, still sent by some browsers
    case "k":
      return "toggle-play";
    case "ArrowLeft":
    case "j":
      return "seek-back";
    case "ArrowRight":
    case "l":
      return "seek-forward";
    case "ArrowUp":
      return "volume-up";
    case "ArrowDown":
      return "volume-down";
    case "m":
      return "toggle-mute";
    case "f":
      return "toggle-fullscreen";
    default:
      return null;
  }
}

/**
 * True when a keypress is aimed at something the viewer is typing into.
 *
 * The player listens on the document, so without this a space typed into the
 * comment box would both type a space and pause the film behind it.
 */
export function isTypingTarget(target: {
  tagName?: string;
  isContentEditable?: boolean;
} | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Where the remembered volume lives in this browser. */
export const VOLUME_STORAGE_KEY = "genhub:player:volume";

/** The volume a bare number means: inside 0–1, and never NaN. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * The volume stored from last time, or null when there is nothing usable.
 *
 * Null — rather than a default — is the point: a browser that refuses storage
 * (private mode) and an entry somebody's extension mangled both have to end in
 * the volume the player would have used anyway, not in silence.
 */
export function parseStoredVolume(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}
