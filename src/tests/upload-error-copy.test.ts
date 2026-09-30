// =============================================================================
// GENHUB - What a creator is told when an upload dies
//
// The transport's sentences used to carry their own diagnosis: "the video
// service would not open this upload (HTTP 502)", "the video service refused a
// chunk (HTTP 409)", "Bunny still lists this video as empty (status 0)". Every
// one of those is a fact about the deployment, the provider, and how many
// requests it takes to move a file — handed to whoever asked, on demand, one
// error message at a time. A creator can act on none of it.
//
// The split pinned here is that the DETAIL still exists, in the two places that
// are allowed to hold it (the failure record's fields, and the server log behind
// a correlation reference), and that the SENTENCE the browser receives names no
// provider, no status code, no chunk, and no environment variable.
//
// This is a source-level check because the deliverable is the wording, and
// wording is exactly what a later commit changes while chasing something else.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Every file that can put an upload failure in front of a creator. */
const SURFACES = [
  "src/lib/video-upload.ts",
  "src/lib/upload-client.ts",
  "src/app/api/upload/route.ts",
  "src/app/api/videos/upload-signature/route.ts",
  "src/app/api/videos/upload-complete/route.ts",
  "src/app/api/videos/upload-abort/route.ts",
  "src/app/api/videos/route.ts",
  "src/app/api/videos/[id]/route.ts",
  "src/app/api/videos/[id]/stream/route.ts",
  "src/app/creator/upload/page.tsx",
  "src/app/creator/page.tsx",
];

/** Block and line comments removed, so prose about the machinery is not read as copy. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

const read = (file: string) => stripComments(readFileSync(file, "utf8"));

/**
 * The sentences a creator can actually be shown.
 *
 * Four delivery paths, each read on its own terms:
 *   * the first argument of an `api.*` error — the response body's `error`;
 *   * a `message:` field, which is how `api.upstream` sends a plain sentence
 *     while its first argument stays in the log;
 *   * a `toast(...)` call on the two creator pages;
 *   * the messages of the upload transport, which are literals and named
 *     constants in `src/lib`.
 */
function creatorFacingSentences(source: string): string[] {
  const found: string[] = [];

  for (const call of source.matchAll(
    /api\.(?:error|validation|forbidden|unauthorized|rateLimited|notFound|conflict)\(\s*(?:"([^"]+)"|`([^`]+)`)/g
  )) {
    found.push(call[1] ?? call[2]);
  }

  for (const message of source.matchAll(/\bmessage:\s*(?:"([^"]+)"|`([^`]+)`)/g)) {
    found.push(message[1] ?? message[2]);
  }

  for (const toast of source.matchAll(/toast\(\s*"(?:success|error|warning|info)"\s*,\s*"([^"]+)"/g)) {
    found.push(toast[1]);
  }

  return found;
}

/**
 * The transport is judged as a whole: its sentences are literals, constants and
 * template strings, and a rule that listed the call sites would miss a message
 * moved into a constant. Short literals are skipped because they are field
 * names, MIME types and `stage` values — `"chunk"` as a stage is data, and it is
 * never rendered.
 */
function transportSentences(source: string): string[] {
  const found: string[] = [];
  for (const literal of source.matchAll(/"([^"\\\n]{15,})"|`([^`\\]{15,})`/g)) {
    const text = literal[1] ?? literal[2];
    // A sentence has spaces in it. Everything without one is code: the upload
    // endpoint's URL, the host it is checked against, a MIME type, a header
    // name. Those are addresses and identifiers, never things anybody reads.
    if (text.includes(" ")) found.push(text);
  }
  return found;
}

/** A machine code, not a sentence — `UPLOAD_INCOMPLETE`, `NOT_CONFIGURED`. */
const isCode = (text: string) => /^[A-Z0-9_]+$/.test(text);

/**
 * Upstream detail. Every one of these is either useless to the creator or useful
 * to somebody probing the app: the provider's name, the transport's, a status
 * code, the unit the file moves in, and the deployment's own variables.
 */
const UPSTREAM_DETAIL =
  /\bHTTP\s?\d|\bHTTP\s?\$|video service|video host|\bchunk\b|\bbunny\b|\btus\b|BUNNY_|cdn|storage zone|\bprovider\b|\bupstream\b|\benv\b|\.env\b/i;

describe("no creator-facing upload error names the machinery", () => {
  for (const file of SURFACES) {
    it(`${file} keeps its sentences clean`, () => {
      const source = read(file);
      const sentences = creatorFacingSentences(source);
      const offenders = sentences.filter(
        (sentence) => !isCode(sentence) && UPSTREAM_DETAIL.test(sentence)
      );
      expect(offenders, `${file} shows the machinery: ${offenders.join(" | ")}`).toEqual([]);
    });
  }

  it("keeps the whole upload transport's vocabulary out of the sentence layer", () => {
    for (const file of ["src/lib/video-upload.ts", "src/lib/upload-client.ts"]) {
      const offenders = transportSentences(read(file)).filter(
        (sentence) => !isCode(sentence) && UPSTREAM_DETAIL.test(sentence)
      );
      expect(offenders, `${file} shows the machinery: ${offenders.join(" | ")}`).toEqual([]);
    }
  });
});

describe("the detail is moved, not deleted", () => {
  it("still records the provider's own body and status on the failure record", () => {
    const transport = readFileSync("src/lib/video-upload.ts", "utf8");
    // The record is what an operator reads, so the shape of the failure has to
    // survive even though the sentence no longer spells it out.
    expect(transport).toContain("providerBody");
    expect(transport).toContain("status");
    expect(transport).toContain("reason:");
    expect(transport).toMatch(/providerBody:\s*body/);
  });

  it("names the missing configuration in the log, not in the response", () => {
    const signature = readFileSync("src/app/api/videos/upload-signature/route.ts", "utf8");
    expect(signature).toContain('console.error(\n        "[Video Upload] not configured:');
    expect(signature).not.toMatch(/api\.error\(\s*"[^"]*(BUNNY_|JWT_SECRET)/);
  });

  it("logs what the host said about an unfinished upload", () => {
    const complete = readFileSync("src/app/api/videos/upload-complete/route.ts", "utf8");
    expect(complete).toContain('console.warn("[Video Upload] not complete:",');
    // The diagnosis is not interpolated into the response any more.
    expect(complete).not.toMatch(/api\.error\(\s*`[^`]*\$\{confirmed\.detail\}/);
  });

  it("keeps the environment variables in the log behind a reference", () => {
    const stream = readFileSync("src/app/api/videos/[id]/stream/route.ts", "utf8");
    expect(stream).toContain("api.upstream(");
    expect(stream).toContain("BUNNY_CDN_HOSTNAME / BUNNY_TOKEN_SECRET are not both set");
    // ...and the sentence the viewer reads from that call is not the one that
    // names them.
    const message = stream.match(/code: "NOT_CONFIGURED",\s*\n\s*message: "([^"]+)"/);
    expect(message?.[1]).toBeTruthy();
    expect(message?.[1]).not.toMatch(/BUNNY_|\bHTTP\b/);
  });
});
