// =============================================================================
// GENHUB - What sits under the picture, and in what order
//
// The video page used to stack its details in front of the recommendations in
// the worst possible order: title, creator, description, tags, actions, gallery,
// comments, and only then "More scenes". Two of those blocks grow without limit
// — a long write-up, a long comment thread — and anything tall above the grid
// is what buried it. Measured on a real scene with two comments, the grid sat
// 1101px below the fold on a phone (0.8 of a screen on desktop), and on a scene
// with a real thread it only gets worse. The complaint was concrete: "the videos
// below are only visible after scrolling".
//
// These are source-order assertions. The page is one 2500-line client component
// whose layout is JSX structure, and the thing that has to stay true is the
// ORDER of two blocks — not the value any function returns. A rendering test
// would need a browser and a database to say less; this runs in milliseconds and
// fails the moment somebody moves the grid back under the comments, which is
// exactly the regression that matters.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const PAGE = read("src", "app", "video", "[id]", "VideoDetail.tsx");
const CSS = read("src", "app", "globals.css");

/**
 * The grid's own heading, not the words "More scenes" — those also appear in a
 * state comment near the top of the file, and a marker that matches prose
 * instead of markup would happily pass while the real order was broken.
 */
const MORE_SCENES = "/> More scenes";

/** Where a marker appears in the page source, or a failure naming it. */
function at(marker: string): number {
  const index = PAGE.indexOf(marker);
  expect(index, `VideoDetail.tsx no longer contains ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

describe("the video page puts recommendations above the sections that grow", () => {
  it("renders More scenes before the comments", () => {
    expect(at(MORE_SCENES)).toBeLessThan(at("<CommentsSection"));
  });

  it("renders More scenes before the gallery", () => {
    expect(at(MORE_SCENES)).toBeLessThan(at("{/* Scene photo gallery */}"));
  });

  it("keeps the details above the recommendations — the order is a swap, not a rewrite", () => {
    // The description, the tags and the actions are still part of the reading
    // column; only the two unbounded blocks moved below the grid.
    expect(at("{/* Description")).toBeLessThan(at(MORE_SCENES));
    expect(at("{/* Action Buttons")).toBeLessThan(at(MORE_SCENES));
  });

  it("clamps a long write-up instead of letting it push the page down", () => {
    // The description was the unbounded block ABOVE the grid that nothing
    // guarded: several screens of text, with everything after it off the bottom.
    expect(PAGE).toContain('showFullDescription ? "" : "line-clamp-3"');
    expect(PAGE).toContain("Show more");
    // And a new scene starts clamped again, not carrying the last one's answer.
    expect(PAGE).toMatch(/setShowFullDescription\(false\)/);
  });
});

describe("the action row does not eat a phone screen", () => {
  it("scrolls sideways on a narrow viewport instead of wrapping", () => {
    // Measured at 390px wide: wrapped, this row is 202px tall — four stacked
    // lines, and most of the detail block (436px). Nowrap + shrink-0 keeps the
    // buttons on one line and the row scrolls; `sm:flex-wrap` restores the
    // normal wrapping wherever there is room for it.
    // Read the row's own className, not a slice up to the first "}" or ">" —
    // the arbitrary variant `[&>*]:shrink-0` contains both characters.
    const classStart = PAGE.indexOf('className="', at("{/* Action Buttons"));
    const rowClasses = PAGE.slice(classStart, PAGE.indexOf('"', classStart + 11));
    expect(rowClasses).toContain("flex-nowrap");
    expect(rowClasses).toContain("overflow-x-auto");
    expect(rowClasses).toContain("sm:flex-wrap");
    expect(rowClasses).toContain("[&>*]:shrink-0");
    // The right-aligned Report button only floats right where the row wraps.
    expect(PAGE).toContain("sm:ml-auto");
  });

  it("hides the scrollbar strip the sideways row would otherwise draw", () => {
    // The base layer styles ::-webkit-scrollbar width (vertical). A horizontal
    // bar takes its thickness from `height`, so it fell back to ~15px of
    // bg-surface-600 — a dark band across the page under the row. The class has
    // to exist in the stylesheet AND be applied, so both are pinned here.
    expect(CSS).toContain(".no-scrollbar");
    expect(CSS).toMatch(/\.no-scrollbar::-webkit-scrollbar\s*\{\s*display:\s*none;/);
    expect(CSS).toMatch(/\.no-scrollbar\s*\{[^}]*scrollbar-width:\s*none;/);
    expect(PAGE).toContain('className="no-scrollbar flex flex-nowrap');
  });
});
