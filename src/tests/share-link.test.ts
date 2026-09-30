// =============================================================================
// GENHUB - The watch page's share link, and the URL it puts on the clipboard
//
// The button used to do one thing OR the other, never both: if the browser
// exposed `navigator.share` it handed the URL to the OS sheet and stopped —
// so on the many phones and Safari builds that do, the link was never copied
// at all. Dismissing that sheet also landed in a `catch` that reported
// "Could not share", turning a cancel into an error. And the URL it carried
// came from `window.location.href`, so anything the viewer had in their query
// string travelled with the link.
//
// Three rules are pinned here, each an absence a later commit can undo:
//
//   1. A failed or dismissed share falls THROUGH to the copy, which always
//      works — it is not an error and it does not stop at the sheet.
//   2. The copied URL is the canonical watch path built from the slug, not the
//      raw address bar.
//   3. The copy is confirmed, and a copy that genuinely fails says what to do
//      instead rather than reporting a share failure.
//
// This is a source-level check on purpose: the handler is a handful of lines
// whose arrangement is the deliverable.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const DETAIL = readFileSync("src/app/video/[id]/VideoDetail.tsx", "utf8");

/**
 * The body of `handleShare`, from its declaration to the matching close, with
 * line comments stripped — the comments explain the rule and are allowed to
 * name the thing the rule forbids.
 */
function handleShare(): string {
  const start = DETAIL.indexOf("async function handleShare()");
  expect(start, "handleShare is missing").toBeGreaterThan(-1);
  const end = DETAIL.indexOf("\n  }\n", start);
  expect(end, "handleShare has no end").toBeGreaterThan(start);
  return DETAIL.slice(start, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("watch page share link", () => {
  it("falls through to the copy when sharing is dismissed or unavailable", () => {
    const body = handleShare();

    const shareIndex = body.indexOf("navigator.share");
    expect(shareIndex, "the share attempt is missing").toBeGreaterThan(-1);

    // The first catch after the share attempt is the share catch.
    const shareCatch = body.indexOf("catch", shareIndex);
    expect(shareCatch, "the share attempt has no catch").toBeGreaterThan(shareIndex);

    // A `return` inside that catch would abandon the copy — the regression.
    const shareCatchEnd = body.indexOf("}", body.indexOf("{", shareCatch));
    expect(body.slice(shareCatch, shareCatchEnd)).not.toMatch(/\breturn\b/);

    // The copy sits outside the share branch, so it runs in every case: no
    // share support, share dismissed, and plain copy alike.
    const copyIndex = body.indexOf("clipboard.writeText");
    expect(copyIndex, "the copy is gone").toBeGreaterThan(-1);
    expect(copyIndex, "the copy must come after the share fall-through").toBeGreaterThan(
      shareCatchEnd
    );
  });

  it("copies the canonical watch URL instead of the address bar", () => {
    const body = handleShare();
    expect(body).not.toMatch(/window\.location\.href/);
    expect(body).toMatch(/window\.location\.origin/);
    expect(body).toMatch(/\/video\/\$\{video\.slug \|\| video\.id\}/);
  });

  it("confirms the copy and names a way out when it fails", () => {
    const body = handleShare();

    const success = body.match(/toast\(\s*"success"\s*,\s*"([^"]*)"/);
    expect(success, "the copy is not confirmed").not.toBeNull();
    expect(success![1]).toMatch(/kopiwa|copied/i);

    // No "could not share" anywhere — a dismissed sheet is not a failure, and a
    // failed copy is the clipboard's problem, not sharing's.
    expect(body).not.toMatch(/Could not share/);

    const failure = body.match(/toast\(\s*"(?:error|warning)"\s*,\s*"([^"]*)"/);
    expect(failure, "a failed copy says nothing").not.toBeNull();
    expect(failure![1]).toMatch(/copy it by hand|nakili/i);
  });

  it("shows the viewer that the link is on their clipboard", () => {
    expect(DETAIL).toMatch(/const \[linkCopied,\s*setLinkCopied\]/);
    expect(DETAIL).toMatch(/setLinkCopied\(true\)/);
    expect(DETAIL).toMatch(/Copied/);
  });
});
