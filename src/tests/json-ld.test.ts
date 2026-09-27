// =============================================================================
// GENHUB - A user-written title cannot close the JSON-LD script tag
//
// Structured data is rendered with `dangerouslySetInnerHTML`, and the fields in
// it (video title, description, creator name) are typed by users. `JSON.stringify`
// does not escape `<`, and the HTML parser ends a `<script>` element at the first
// `</script` it meets — so a title of
// `</script><script>…</script>` used to run as script on every visitor's page.
// It was reproduced in a browser before it was fixed: the injected script ran.
//
// These tests pin the serializer AND the call sites, because a future page that
// builds its own JSON-LD with `JSON.stringify` would reintroduce exactly the bug
// that was just closed.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeJsonLd } from "@/lib/json-ld";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const BREAKOUT = "</script><script>window.pwned = 1</script>";
const JSON_LD_PAGES = [
  ["src", "app", "layout.tsx"],
  ["src", "app", "creator", "[id]", "page.tsx"],
  ["src", "app", "video", "[id]", "page.tsx"],
  ["src", "app", "video", "[id]", "VideoDetail.tsx"],
];

describe("serializeJsonLd", () => {
  it("never emits a character the HTML parser can act on", () => {
    const out = serializeJsonLd({ name: BREAKOUT, description: "a & b > c" });

    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
    expect(out).toContain("\\u003c");
  });

  it("still carries the exact original value", () => {
    const data = { title: BREAKOUT, tags: ["a<b", "c&d"], n: 3, missing: null };

    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });

  it("escapes the line separators that would break an inline script", () => {
    const out = serializeJsonLd({ title: "a\u2028b\u2029c" });

    expect(out).not.toContain("\u2028");
    expect(out).not.toContain("\u2029");
    expect(JSON.parse(out)).toEqual({ title: "a\u2028b\u2029c" });
  });

  it("is valid JSON for nothing at all", () => {
    expect(serializeJsonLd(undefined)).toBe("null");
    expect(serializeJsonLd(null)).toBe("null");
  });
});

describe("every JSON-LD tag in the app", () => {
  it("goes through the serializer", () => {
    for (const parts of JSON_LD_PAGES) {
      const source = read(...parts);
      expect(source, parts.join("/")).toContain("serializeJsonLd(");
    }
  });

  it("does not hand a raw JSON.stringify to dangerouslySetInnerHTML anywhere", () => {
    for (const parts of JSON_LD_PAGES) {
      const source = read(...parts);
      // The exact shape of the bug: a stringified object written straight into
      // __html.
      expect(source, parts.join("/")).not.toMatch(/__html:\s*JSON\.stringify/);
    }
  });
});
