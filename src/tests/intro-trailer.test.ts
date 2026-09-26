import { describe, it, expect } from "vitest";
import { shouldShowIntroTrailer } from "@/lib/intro-trailer";

const base = {
  canPlayFull: false,
  notPlayable: false,
  teaserUrl: "https://cdn.example.com/teaser.m3u8",
  price: 1000,
};

describe("shouldShowIntroTrailer", () => {
  it("shows the intro for a paid, playable scene with a trailer clip", () => {
    expect(shouldShowIntroTrailer(base)).toBe(true);
  });

  it("never shows the intro to a viewer who can already play the scene", () => {
    expect(shouldShowIntroTrailer({ ...base, canPlayFull: true })).toBe(false);
  });

  it("hides the intro while the scene is still encoding or has failed", () => {
    expect(shouldShowIntroTrailer({ ...base, notPlayable: true })).toBe(false);
  });

  it("hides the intro when there is no trailer clip to play", () => {
    expect(shouldShowIntroTrailer({ ...base, teaserUrl: null })).toBe(false);
    expect(shouldShowIntroTrailer({ ...base, teaserUrl: undefined })).toBe(false);
    expect(shouldShowIntroTrailer({ ...base, teaserUrl: "" })).toBe(false);
  });

  it("hides the intro for a free scene (nothing to unlock)", () => {
    expect(shouldShowIntroTrailer({ ...base, price: 0 })).toBe(false);
  });

  it("still shows the intro for the cheapest paid scene", () => {
    expect(shouldShowIntroTrailer({ ...base, price: 1 })).toBe(true);
  });
});
