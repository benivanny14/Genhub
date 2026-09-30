// =============================================================================
// GENHUB - The copy-link controls, and the clipboard behind them
//
// `navigator.clipboard.writeText` refuses in two ordinary situations: there is
// no secure context (a plain-HTTP LAN address has no `navigator.clipboard` at
// all) and the document is not focused (it rejects with NotAllowedError,
// "Document is not focused"). Every copy control called it directly and caught
// the throw into a warning, so on those pages the link was never copied.
//
// Three rules are pinned here, each an absence a later commit can undo:
//
//   1. One helper owns the copy. No surface calls `navigator.clipboard` itself,
//      so the fallback cannot be forgotten at one call site.
//   2. The fallback exists and is selection-based — the only copy that works
//      without a secure context or a focused document.
//   3. The watch page's share control offers the OS share sheet when there is
//      one, and always leaves a usable link behind when there is not: dismissing
//      the sheet falls through to the helper rather than ending the click.
//
// The first two are source-level checks because the deliverable is the
// arrangement of a few lines; a wording or ordering change is the thing guarded.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HELPER = readFileSync("src/lib/clipboard.ts", "utf8");
const DETAIL = readFileSync("src/app/video/[id]/VideoDetail.tsx", "utf8");
const CREATOR = readFileSync("src/app/creator/page.tsx", "utf8");
const PROFILE = readFileSync("src/app/profile/page.tsx", "utf8");

/** Every copy control in the app, with the label used in failure messages. */
const SURFACES: { name: string; source: string }[] = [
  { name: "watch page", source: DETAIL },
  { name: "creator dashboard", source: CREATOR },
  { name: "profile page", source: PROFILE },
];

/**
 * A function body, from its declaration to the next sibling at the same
 * indentation, with line comments stripped — the comments explain the rule and
 * are allowed to name the thing the rule forbids.
 */
function body(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `"${declaration}" was not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  expect(end, `"${declaration}" has no end`).toBeGreaterThan(start);
  return source
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("clipboard helper", () => {
  it("falls back to the selection copy when the async API is missing", () => {
    // `navigator.clipboard.writeText` is attempted, but only inside a try that
    // falls through — the helper must never return false just because the
    // async API threw.
    expect(HELPER).toMatch(/navigator\.clipboard\?\.writeText/);
    expect(HELPER).toMatch(/catch\s*\{[\s\S]*?\}\s*return legacyCopy/);

    // The fallback is the selection-based copy, and nothing else.
    expect(HELPER).toMatch(/document\.execCommand\(\s*"copy"\s*\)/);
    expect(HELPER).toMatch(/document\.createElement\(\s*"textarea"\s*\)/);

    // A hidden element cannot be selected, so the copy would take nothing —
    // the temporary area must stay laid out and merely be moved away.
    expect(HELPER).not.toMatch(/display\s*=\s*"none"/);
    expect(HELPER).not.toMatch(/visibility\s*=\s*"hidden"/);
    expect(HELPER).toMatch(/position\s*=\s*"fixed"/);
  });

  it("returns a falsy value instead of throwing when there is no document", () => {
    // Server-render and test environments have no document; the helper must
    // answer, not throw.
    expect(HELPER).toMatch(/typeof document === "undefined"/);
  });
});

describe("every copy control", () => {
  it("copies through the shared helper, never the raw API", () => {
    for (const { name, source } of SURFACES) {
      expect(source, `${name} does not use the helper`).toMatch(
        /import \{ copyToClipboard \} from "@\/lib\/clipboard"/
      );
      expect(source, `${name} still calls the raw clipboard API`).not.toMatch(
        /navigator\.clipboard\.writeText/
      );
    }
  });
});

describe("watch page share button", () => {
  const handler = body(DETAIL, "async function handleShare()");

  it("offers the OS share sheet first, then falls through to the copy", () => {
    expect(handler, "the share sheet was dropped").toMatch(/navigator\.share/);
    expect(handler).toMatch(/await navigator\.share\(/);
    expect(handler).toMatch(/await copyToClipboard\(url\)/);

    // Dismissing the sheet is not an error: the copy must come AFTER it, so a
    // cancelled share still lands the link on the clipboard.
    const shareAt = handler.indexOf("navigator.share");
    const copyAt = handler.indexOf("copyToClipboard(url)");
    expect(shareAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(shareAt);
  });

  it("copies the canonical watch URL instead of the address bar", () => {
    expect(handler).not.toMatch(/window\.location\.href/);
    expect(handler).toMatch(/window\.location\.origin/);
    expect(handler).toMatch(/\/video\/\$\{video\.slug \|\| video\.id\}/);
  });

  it("confirms a copy and names a way out when even that fails", () => {
    const success = handler.match(/toast\(\s*"success"\s*,\s*"([^"]*)"/);
    expect(success, "the copy is not confirmed").not.toBeNull();
    expect(success![1]).toMatch(/kopiwa|copied/i);

    // A failure is the clipboard's problem, not sharing's — the old wording
    // blamed sharing for a dismissed sheet that was never an error.
    expect(handler).not.toMatch(/Could not share/);

    const failure = handler.match(/toast\(\s*"(?:error|warning)"\s*,\s*"([^"]*)"/);
    expect(failure, "a failed copy says nothing").not.toBeNull();
    expect(failure![1]).toMatch(/copy it by hand|nakili/i);

    // The failure path must return, so the success toast cannot follow it.
    expect(handler).toMatch(/if\s*\(!copied\)\s*\{[\s\S]*?return;[\s\S]*?\}/);
  });

  it("shows the viewer that the link is on their clipboard", () => {
    expect(DETAIL).toMatch(/const \[linkCopied,\s*setLinkCopied\]/);
    expect(DETAIL).toMatch(/setLinkCopied\(true\)/);
    expect(DETAIL).toMatch(/Copied/);
  });
});
