// =============================================================================
// GENHUB - Editing a video's price
//
// The creator's edit form offers "0 makes it free" and its price field has no
// lower bound. The schema behind it required at least TZS 100, so the promise
// was broken by a validation error nobody could act on: there was no way to make
// a scene free once it had been uploaded, even though the rest of the site has a
// whole code path for free videos (price 0 skips the paywall, the entitlement
// service returns "free" before it looks at the viewer at all, and the feed
// shows the full video rather than a teaser).
//
// Asserted here:
//   1. 0 is accepted on UPDATE — the edit form can make a video free
//   2. a negative price is refused, with a message that says what is wrong
//   3. the upper bound is still enforced
//   4. the price stays optional, so editing only the title still works
//   5. UPLOADING still requires a price: a sale cannot be taken back from buyers
//      who already paid, and that asymmetry is deliberate
// =============================================================================

import { describe, it, expect } from "vitest";
import { createVideoSchema, updateVideoSchema } from "@/lib/validation";

describe("updateVideoSchema captions", () => {
  it("accepts an uploaded WebVTT file", () => {
    const result = updateVideoSchema.safeParse({
      captionsUrl: "/api/media/public/captions/2026-09/abc123.vtt",
    });

    expect(result.success).toBe(true);
  });

  it("accepts an https link to a .vtt", () => {
    expect(
      updateVideoSchema.safeParse({ captionsUrl: "https://cdn.example.com/scene.vtt" }).success
    ).toBe(true);
  });

  it("refuses .srt with a message naming the problem", () => {
    // A browser handed an .srt renders nothing and logs nothing, so a creator
    // would believe the captions were live. This refusal is the only place they
    // find out while they can still fix it.
    const result = updateVideoSchema.safeParse({
      captionsUrl: "https://cdn.example.com/scene.srt",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toMatch(/\.vtt/);
    }
  });

  it("refuses a plain http link", () => {
    expect(
      updateVideoSchema.safeParse({ captionsUrl: "http://cdn.example.com/scene.vtt" }).success
    ).toBe(false);
  });

  it("refuses a javascript: URL dressed up as a caption file", () => {
    expect(
      updateVideoSchema.safeParse({ captionsUrl: "javascript:alert(1).vtt" }).success
    ).toBe(false);
  });

  it("accepts \"\" as \"remove the captions\"", () => {
    const result = updateVideoSchema.safeParse({ captionsUrl: "" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.captionsUrl).toBe("");
  });

  it("leaves captions alone when the field is absent", () => {
    expect(updateVideoSchema.safeParse({ title: "Only a title" }).success).toBe(true);
  });
});

describe("updateVideoSchema price", () => {
  it("accepts 0, so a creator can make a video free", () => {
    const result = updateVideoSchema.safeParse({ price: 0 });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.price).toBe(0);
  });

  it("refuses a negative price and says why", () => {
    const result = updateVideoSchema.safeParse({ price: -100 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toMatch(/negative/i);
    }
  });

  it("keeps the upper bound", () => {
    expect(updateVideoSchema.safeParse({ price: 1_000_001 }).success).toBe(false);
    expect(updateVideoSchema.safeParse({ price: 1_000_000 }).success).toBe(true);
  });

  it("still allows a title-only edit", () => {
    expect(updateVideoSchema.safeParse({ title: "A new title" }).success).toBe(true);
    expect(updateVideoSchema.safeParse({}).success).toBe(true);
  });

  it("rounds nothing: a fractional price is rejected rather than charged", () => {
    expect(updateVideoSchema.safeParse({ price: 100.5 }).success).toBe(false);
  });
});

describe("createVideoSchema price", () => {
  const base = {
    title: "A scene",
    price: 1000,
    bunnyVideoId: "39ea50b0-bee6-4175-90fe-99710ecc3848",
    complianceAttested: true,
  };

  it("still requires at least TZS 100 at upload time", () => {
    expect(createVideoSchema.safeParse({ ...base, price: 0 }).success).toBe(false);
    expect(createVideoSchema.safeParse(base).success).toBe(true);
  });
});
