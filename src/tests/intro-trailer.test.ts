import { describe, it, expect } from "vitest";
import { pickIntroMedium, hasIntro } from "@/lib/intro-trailer";

const base = {
  canPlayFull: false,
  notPlayable: false,
  teaserUrl: null as string | null,
  previewAnimationUrl: "https://cdn.example.com/abc/preview.webp?token=t&expires=1",
  price: 1000,
};

describe("pickIntroMedium", () => {
  it("prefers the creator's uploaded trailer", () => {
    expect(
      pickIntroMedium({ ...base, teaserUrl: "https://cdn.example.com/abc/teaser.m3u8" })
    ).toBe("trailer");
  });

  it("falls back to Bunny's animated preview when there is no trailer", () => {
    expect(pickIntroMedium(base)).toBe("animation");
  });

  it("keeps the trailer preferred even when an animation is also available", () => {
    expect(
      pickIntroMedium({
        ...base,
        teaserUrl: "https://cdn.example.com/abc/teaser.m3u8",
      })
    ).toBe("trailer");
  });

  it("never shows an intro to a viewer who can already play the scene", () => {
    expect(pickIntroMedium({ ...base, canPlayFull: true })).toBe("none");
  });

  it("shows nothing while the scene is encoding or has failed", () => {
    expect(pickIntroMedium({ ...base, notPlayable: true })).toBe("none");
  });

  it("shows nothing for a free scene (nothing to unlock)", () => {
    expect(pickIntroMedium({ ...base, price: 0 })).toBe("none");
  });

  it("gives up on the animation once it has failed to load", () => {
    expect(pickIntroMedium({ ...base, animationFailed: true })).toBe("none");
  });

  it("shows nothing when there is neither asset", () => {
    expect(pickIntroMedium({ ...base, previewAnimationUrl: null })).toBe("none");
    expect(pickIntroMedium({ ...base, previewAnimationUrl: undefined })).toBe("none");
  });
});

describe("hasIntro", () => {
  it("is true whenever some intro exists", () => {
    expect(hasIntro(base)).toBe(true);
    expect(hasIntro({ ...base, teaserUrl: "https://x/teaser.m3u8" })).toBe(true);
  });

  it("is false when the viewer can already watch, or nothing is available", () => {
    expect(hasIntro({ ...base, canPlayFull: true })).toBe(false);
    expect(hasIntro({ ...base, previewAnimationUrl: null })).toBe(false);
    expect(hasIntro({ ...base, price: 0 })).toBe(false);
  });
});
