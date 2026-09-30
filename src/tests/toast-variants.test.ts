// =============================================================================
// GENHUB - The four kinds of toast
//
// A toast is the only place a creator is told that something went wrong, and
// for a long time every kind of message looked the same bar a tint: one shape,
// one motion, one icon size, four colours. A warning about an upload and a
// confirmation that a video published were the same object in different paint,
// so the fastest read on screen — the shape — said nothing at all.
//
// These checks pin the separation that replaced it. They are deliberately about
// the difference BETWEEN the four kinds rather than the exact classes: a later
// restyle is free to change how a warning looks, as long as it still looks like
// nothing else on the stack. The last check is the one that protects the ~260
// existing callers: the provider's API is what they use, and it must not move.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TOAST = readFileSync("src/components/Toast.tsx", "utf8");
const TAILWIND = readFileSync("tailwind.config.ts", "utf8");

/** The types the provider accepts, in the order the file declares them. */
const KINDS = ["success", "error", "warning", "info"] as const;

/** The `VARIANTS` entry for one kind, from its key to the closing brace. */
function variantBlock(kind: string): string {
  const start = TOAST.indexOf(`\n  ${kind}: {`);
  expect(start, `no VARIANTS entry for "${kind}"`).toBeGreaterThan(-1);
  const end = TOAST.indexOf("\n  },", start);
  expect(end, `the "${kind}" entry is not closed`).toBeGreaterThan(start);
  return TOAST.slice(start, end);
}

/** The value of one string field inside a variant entry. */
function field(block: string, name: string): string {
  const match = block.match(new RegExp(`\\b${name}:\\s*"([^"]*)"`));
  expect(match, `the entry has no "${name}"`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

describe("every kind of toast is its own object", () => {
  it("declares an entry for all four kinds", () => {
    for (const kind of KINDS) expect(variantBlock(kind).length).toBeGreaterThan(0);
  });

  it("gives each kind a title, so the kind is readable as a word", () => {
    for (const kind of KINDS) {
      expect(field(variantBlock(kind), "title").trim().length).toBeGreaterThan(0);
    }
  });

  it("never gives two kinds the same title", () => {
    const titles = KINDS.map((kind) => field(variantBlock(kind), "title"));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("paints each kind from its own set of colours", () => {
    // The rail, the icon tile, the wash and the card border are what a glance
    // reads. Two kinds sharing any of them is how four messages collapse back
    // into one message with four tints.
    for (const name of ["shell", "wash", "rail", "tile", "heading", "bar", "close"]) {
      const values = KINDS.map((kind) => field(variantBlock(kind), name));
      expect(new Set(values).size, `two kinds share their "${name}"`).toBe(values.length);
      for (const value of values) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives each kind its own entrance, and defines it", () => {
    for (const kind of KINDS) {
      // The class on the card...
      expect(field(variantBlock(kind), "motion")).toBe(`animate-toast-${kind}`);
      // ...and the two halves of the definition it names, so a class that
      // resolves to nothing cannot pass as a distinct animation.
      expect(TAILWIND).toContain(`"toast-${kind}":`);
      const keyframe = `toast${kind[0].toUpperCase()}${kind.slice(1)}: {`;
      expect(TAILWIND, `tailwind.config.ts has no ${keyframe} keyframes`).toContain(keyframe);
    }
  });

  it("gives no two kinds the same motion", () => {
    const motions = KINDS.map((kind) => field(variantBlock(kind), "motion"));
    expect(new Set(motions).size).toBe(motions.length);
  });

  it("lets an error interrupt a screen reader and holds the rest back", () => {
    expect(field(variantBlock("error"), "role")).toBe("alert");
    for (const kind of KINDS.filter((k) => k !== "error")) {
      expect(field(variantBlock(kind), "role")).toBe("status");
    }
  });
});

describe("the provider's API is untouched", () => {
  it("still offers the same calls the app already makes", () => {
    // Every one of these has callers today; renaming or dropping one is a
    // compile error in files this test cannot see, which is exactly why it is
    // asserted here rather than trusted to review.
    for (const call of [
      "toast: addToast",
      'success: (msg) => addToast("success", msg)',
      'error: (msg) => addToast("error", msg)',
      'warning: (msg) => addToast("warning", msg)',
      'info: (msg) => addToast("info", msg)',
      "update: updateToast",
      "dismiss: removeToast",
    ]) {
      expect(TOAST, `the provider no longer exposes "${call}"`).toContain(call);
    }
  });

  it("keeps a sticky toast sticky and a progress bar a progress bar", () => {
    // The video upload creates one toast and rewrites it on every chunk. A timer
    // on those rewrites is how a progress toast disappears mid-upload, and the
    // bar is the only thing on screen that says the transfer is still moving.
    expect(TOAST).toContain("if (!toast.duration) return;");
    expect(TOAST).toContain('role="progressbar"');
    expect(TOAST).toContain("aria-valuenow");
  });
});
