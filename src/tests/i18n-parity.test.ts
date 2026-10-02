// =============================================================================
// GENHUB - Translation parity
//
// A screen that stays English in Kiswahili mode is almost always a missing
// `sw` string rather than a missing `useI18n()` call, so every key must carry
// a non-empty value in BOTH languages, and both languages must interpolate the
// same named params (otherwise one language renders a literal "{p}").
// =============================================================================

import { describe, it, expect } from "vitest";
import { translations } from "@/lib/translations";

const LOCALES = ["en", "sw"] as const;

/** Named placeholders like {n}, {p}, {t} — compared across locales. */
function params(text: string): string[] {
  return Array.from(text.matchAll(/\{([a-zA-Z0-9_]+)\}/g), (m) => m[1]).sort();
}

describe("translation dictionary", () => {
  const entries = Object.entries(translations);

  it("has entries at all", () => {
    expect(entries.length).toBeGreaterThan(200);
  });

  it("every key has a non-empty string in both languages", () => {
    const missing: string[] = [];
    for (const [key, value] of entries) {
      for (const locale of LOCALES) {
        const text = value[locale];
        if (typeof text !== "string" || text.trim() === "") {
          missing.push(`${key}.${locale}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("both languages use the same placeholders", () => {
    const mismatched: string[] = [];
    for (const [key, value] of entries) {
      const en = params(value.en);
      const sw = params(value.sw);
      if (en.join(",") !== sw.join(",")) {
        mismatched.push(`${key}: en={${en.join(",")}} sw={${sw.join(",")}}`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
