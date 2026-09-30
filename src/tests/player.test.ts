// =============================================================================
// GENHUB - The player's decisions, pinned
//
// The player component owns the video element and the pixels; every judgement it
// makes about them lives in lib/player.ts and is tested here, in a node process,
// where a phone cannot be the thing that finds out. The three cases worth naming:
//
//   * `video.buffered` is a LIST of disjoint ranges. After a seek there is a hole
//     in the middle of it, and the bar has to draw the range the playhead is in
//     rather than the furthest one — otherwise the bar claims the whole film is
//     loaded, which is a promise the connection has not made.
//   * `duration` is `NaN` until metadata arrives, and `NaN%` width makes the
//     progress bar vanish entirely.
//   * Ctrl/Meta/Alt belong to the browser. A player that swallows Ctrl+S or
//     Cmd+F is broken in a way the viewer cannot diagnose.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  PLAYBACK_RATES,
  bufferedEndAt,
  clampVolume,
  isTypingTarget,
  parseStoredVolume,
  playerShortcutFor,
  progressPercent,
  rateLabel,
  type TimeRangesLike,
} from "@/lib/player";

/** `video.buffered` as the browser hands it over: disjoint, index-based. */
function ranges(...pairs: [number, number][]): TimeRangesLike {
  return {
    length: pairs.length,
    start: (index) => pairs[index][0],
    end: (index) => pairs[index][1],
  };
}

describe("rateLabel", () => {
  it("names the ordinary speed instead of numbering it", () => {
    expect(rateLabel(1)).toBe("Normal");
  });

  it("reads a slower or faster speed the way a player does", () => {
    expect(rateLabel(0.5)).toBe("0.5×");
    expect(rateLabel(0.75)).toBe("0.75×");
    expect(rateLabel(1.25)).toBe("1.25×");
    expect(rateLabel(2)).toBe("2×");
  });

  it("falls back to Normal for a rate that is not one", () => {
    expect(rateLabel(Number.NaN)).toBe("Normal");
    expect(rateLabel(0)).toBe("Normal");
  });

  it("offers the speeds a viewer expects, with 1 included", () => {
    expect(PLAYBACK_RATES).toContain(1);
    expect(PLAYBACK_RATES[0]).toBeLessThan(1);
    expect(PLAYBACK_RATES[PLAYBACK_RATES.length - 1]).toBeGreaterThan(1);
  });
});

describe("progressPercent", () => {
  it("measures the playhead against the length", () => {
    expect(progressPercent(30, 120)).toBe(25);
    expect(progressPercent(0, 120)).toBe(0);
  });

  it("never divides by a duration it does not have", () => {
    // `NaN` here is what a bar with no width would look like — i.e. a missing
    // progress bar, on a video that is merely still loading.
    expect(progressPercent(10, Number.NaN)).toBe(0);
    expect(progressPercent(Number.NaN, 100)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
  });

  it("stays inside the bar", () => {
    // A live edge or a rounding blip must not push the fill past its track.
    expect(progressPercent(-5, 100)).toBe(0);
    expect(progressPercent(150, 100)).toBe(100);
  });
});

describe("bufferedEndAt", () => {
  it("reports the end of the range the playhead is in", () => {
    expect(bufferedEndAt(ranges([0, 90]), 10)).toBe(90);
  });

  it("picks the playhead's own range, not the furthest one", () => {
    // The measured shape after a seek: a hole between two loaded stretches.
    // Reading end(length-1) would draw this as a fully loaded film.
    const buffered = ranges([0, 30], [600, 660]);
    expect(bufferedEndAt(buffered, 10)).toBe(30);
    expect(bufferedEndAt(buffered, 620)).toBe(660);
  });

  it("says nothing is buffered ahead when the playhead sits in a hole", () => {
    expect(bufferedEndAt(ranges([0, 30], [600, 660]), 300)).toBe(0);
  });

  it("survives an element with no buffered data at all", () => {
    expect(bufferedEndAt(ranges(), 10)).toBe(0);
    expect(bufferedEndAt(null, 10)).toBe(0);
    expect(bufferedEndAt(undefined, Number.NaN)).toBe(0);
  });

  it("holds onto a range whose end the playhead is sitting exactly on", () => {
    // Buffering stops AT the playhead constantly; blinking the bar off there
    // would look like the buffer collapsing every second.
    expect(bufferedEndAt(ranges([0, 40]), 40)).toBe(40);
  });
});

describe("playerShortcutFor", () => {
  it("maps the keys every player uses", () => {
    expect(playerShortcutFor(" ")).toBe("toggle-play");
    expect(playerShortcutFor("k")).toBe("toggle-play");
    expect(playerShortcutFor("ArrowLeft")).toBe("seek-back");
    expect(playerShortcutFor("ArrowRight")).toBe("seek-forward");
    expect(playerShortcutFor("ArrowUp")).toBe("volume-up");
    expect(playerShortcutFor("ArrowDown")).toBe("volume-down");
    expect(playerShortcutFor("m")).toBe("toggle-mute");
    expect(playerShortcutFor("f")).toBe("toggle-fullscreen");
  });

  it("leaves the browser's own shortcuts alone", () => {
    expect(playerShortcutFor("s", { ctrlKey: true })).toBeNull();
    expect(playerShortcutFor("f", { metaKey: true })).toBeNull();
    expect(playerShortcutFor(" ", { altKey: true })).toBeNull();
  });

  it("does not claim keys it has no action for", () => {
    expect(playerShortcutFor("q")).toBeNull();
    expect(playerShortcutFor("Enter")).toBeNull();
    expect(playerShortcutFor("Escape")).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("recognises a field the viewer is typing into", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("lets the picture and its buttons through", () => {
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("remembered volume", () => {
  it("accepts what a browser stored", () => {
    expect(parseStoredVolume("0")).toBe(0);
    expect(parseStoredVolume("0.35")).toBe(0.35);
    expect(parseStoredVolume("1")).toBe(1);
  });

  it("has no answer for nothing stored, or for nonsense", () => {
    // Null keeps the player's own default: a mangled entry or a browser that
    // refuses storage must not leave a viewer with a silent player.
    expect(parseStoredVolume(null)).toBeNull();
    expect(parseStoredVolume("")).toBeNull();
    expect(parseStoredVolume("loud")).toBeNull();
    expect(parseStoredVolume("2")).toBeNull();
    expect(parseStoredVolume("-0.5")).toBeNull();
  });

  it("clamps anything that reaches the element", () => {
    expect(clampVolume(1.5)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(0.4)).toBe(0.4);
  });
});
