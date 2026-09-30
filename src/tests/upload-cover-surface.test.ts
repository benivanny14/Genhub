// =============================================================================
// GENHUB - The cover picker, and what a creator is told when it fails
//
// Three rules are pinned here, all of them things a later commit can undo by
// accident because they are the absence of something:
//
//   1. The cover has ONE door. It had three (a typed gallery picker, an untyped
//      picker, and the camera), and the extra two only ever existed to work
//      around a filter the phone applies — a workaround that is also one more
//      way for a picture to be invisible in a list it is actually sitting in.
//   2. The teaser clip is gone from the upload form. The server still tolerates
//      the fields for scenes that already carry a trailer, but the form no
//      longer asks for one and no longer sends one.
//   3. Nothing the creator is told about a cover explains how any of it works
//      underneath. A failed transfer needs one instruction, not a mechanism —
//      and a mechanism is free reconnaissance for whoever is reading the screen.
//
// This is a source-level check on purpose: the words are the deliverable, and a
// wording change is the thing being guarded.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const UPLOAD = readFileSync("src/app/creator/upload/page.tsx", "utf8");
const DASHBOARD = readFileSync("src/app/creator/page.tsx", "utf8");

/** A slice of source, from one marker to the next — the section under test. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `"${from}" was not found`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end, `"${to}" does not follow "${from}"`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every string literal a `toast(...)` call is given, one statement at a time. */
function toastLiterals(source: string): string[] {
  const found: string[] = [];
  const calls = source.matchAll(/toast\(\s*"(?:success|error|warning|info)"/g);
  for (const call of calls) {
    const start = call.index as number;
    // Up to the end of THIS statement. A fixed window would read the comments
    // after it, and a comment is allowed to name the machinery.
    const statement = source.slice(start, start + 400).split(";")[0];
    for (const literal of statement.matchAll(/"([^"]*)"/g)) found.push(literal[1]);
  }
  return found;
}

/** The two sentences the cover and upload flows hold as named constants. */
function constantLiterals(source: string): string[] {
  const found: string[] = [];
  for (const name of ["UPLOAD_MAY_NOT_WORK", "COVER_UNREADABLE"]) {
    const match = source.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*"([^"]*)"`));
    expect(match, `${name} is missing or no longer a plain sentence`).not.toBeNull();
    found.push((match as RegExpMatchArray)[1]);
  }
  return found;
}

/**
 * Words that describe machinery, an upstream service, or a place we store
 * things. None of them belong in front of a creator: they are either useless to
 * them or useful to someone probing the app one error message at a time.
 */
const MACHINERY =
  /\bbunny\b|\btus\b|bucket|\bs3\b|\bcdn\b|cloud|google photos|\bdrive\b|\bchunk\b|\btoken\b|\/api\/|localhost|\bstack\b|provider|\bupstream\b|\bhost\b|\benv\b|https?:\/\/|\.json\b|\bsql\b/i;

describe("the cover photo has one door", () => {
  it("keeps the untyped Internal storage / Downloads picker", () => {
    const cover = between(UPLOAD, 'title="Cover photo"', "{/* ---- Right column");
    expect(cover).toContain("From Internal storage / Downloads");
  });

  it("serves the cover from that picker and nothing else", () => {
    const cover = between(UPLOAD, 'title="Cover photo"', "{/* ---- Right column");
    expect(cover).not.toContain("From Gallery / Photos");
    expect(cover).not.toContain("Take a photo");
    // The camera door and the typed gallery door both used a capture / MIME
    // filter. Either one coming back is the third door coming back.
    expect(cover).not.toContain("capture=");
    expect(cover).not.toContain("IMAGE_ACCEPT");
  });

  it("offers exactly one file input under the cover section", () => {
    const cover = between(UPLOAD, 'title="Cover photo"', "{/* ---- Right column");
    const inputs = cover.match(/type="file"/g) ?? [];
    expect(inputs.length).toBe(1);
  });

  it("mirrors the same single door on the dashboard's edit form", () => {
    const editCover = between(DASHBOARD, "Cover image", 'htmlFor="edit-title"');
    expect(editCover).toContain("From Internal storage / Downloads");
    expect(editCover).not.toContain("Or use the camera");
    expect(editCover).not.toContain("capture=");
    expect(editCover).not.toContain("IMAGE_ACCEPT");
  });
});

describe("the teaser clip is gone from the upload form", () => {
  it("has no teaser upload left anywhere in the page", () => {
    for (const dead of [
      "handleTeaserFile",
      "teaserFilesRef",
      "teaserVideoId",
      "teaserSession",
      "teaserProgress",
      "teaserUploading",
      "Teaser clip",
      "teaserUploadSessionToken",
      "teaserBunnyVideoId",
      "Cover & teaser",
    ]) {
      expect(UPLOAD, `"${dead}" is still in the upload page`).not.toContain(dead);
    }
  });

  it("keeps the preview length, which is still how a buyer gets a look", () => {
    // The free preview is built from the scene itself when there is no trailer,
    // so this number survives the teaser clip — it is now the only thing that
    // decides how much of a paid scene is public.
    expect(UPLOAD).toContain("teaserDuration");
    expect(UPLOAD).toContain("Preview seconds");
  });

  it("no longer asks the publish API for a trailer", () => {
    const payload = between(UPLOAD, "await fetch(\"/api/videos\"", "const body = await response.json()");
    expect(payload).toContain("bunnyVideoId");
    expect(payload).not.toContain("teaserBunnyVideoId");
    expect(payload).not.toContain("teaserUploadSessionToken");
  });
});

describe("a failure message says what to do, not how it works", () => {
  it("keeps the cover flow's sentences free of machinery", () => {
    const sentences = [...toastLiterals(UPLOAD), ...constantLiterals(UPLOAD)];
    expect(sentences.length).toBeGreaterThan(5);
    for (const sentence of sentences) {
      expect(MACHINERY.test(sentence), `"${sentence}" describes the machinery`).toBe(false);
    }
  });

  it("does not send a creator to a photos app we do not control", () => {
    // The old copy named Google Photos and Drive by hand. Which provider holds
    // a picture is not the creator's problem and not our business to announce.
    expect(UPLOAD).not.toContain("Google Photos");
    expect(DASHBOARD).not.toContain("Google Photos");
  });

  it("tells a creator whose picture could not be read what to do next", () => {
    const [mayNotWork, unreadable] = constantLiterals(UPLOAD);
    expect(unreadable).toMatch(/choose another/i);
    expect(unreadable).toMatch(/chagua picha nyingine/i);
    expect(mayNotWork).toMatch(/chagua faili lingine/i);
  });
});
