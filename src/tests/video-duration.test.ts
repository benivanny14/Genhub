// =============================================================================
// GENHUB - Refusing a too-short file before it is uploaded
//
// The 8-minute floor was only ever checked after Bunny had encoded the file —
// minutes after the creator had spent their data sending it, and (now that a
// post is published the moment it is uploaded) after the post had been public.
// These pin the local check that runs in the file picker instead.
//
// The important half is what it does NOT refuse. `null` means the browser could
// not read the file's metadata, which happens for containers it cannot parse
// and is common on mobile: a refusal there would block a perfectly good upload
// with no way for the creator to get past it.
// =============================================================================

import { describe, it, expect } from "vitest";
import { shortVideoError } from "@/lib/video-duration";
import { MIN_VIDEO_DURATION_SECONDS } from "@/lib/creator-guidelines";

describe("shortVideoError", () => {
  it("says nothing about a video that meets the floor", () => {
    expect(shortVideoError(MIN_VIDEO_DURATION_SECONDS, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
    expect(shortVideoError(MIN_VIDEO_DURATION_SECONDS * 3, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
  });

  it("refuses a video that is definitely too short", () => {
    const message = shortVideoError(90, MIN_VIDEO_DURATION_SECONDS);
    expect(message).toMatch(/1\.5 minute/);
    expect(message).toMatch(/8 minutes/);
    // The creator has to know the post would come down, not just that it is
    // short — that is the consequence they would otherwise discover in public.
    expect(message).toMatch(/taken down/);
  });

  it("lets an unreadable file through", () => {
    // `null` is the honest answer for a container the browser cannot probe, and
    // the server-side backstop still holds it to the rule.
    expect(shortVideoError(null, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
  });

  it("lets a nonsense measurement through", () => {
    // Infinity is what several mobile browsers report for a fragmented MP4
    // before any seek; NaN is a half-parsed container. Neither is a length.
    expect(shortVideoError(Number.POSITIVE_INFINITY, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
    expect(shortVideoError(Number.NaN, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
    expect(shortVideoError(0, MIN_VIDEO_DURATION_SECONDS)).toBeNull();
  });

  it("reads in seconds when the file is under a minute", () => {
    expect(shortVideoError(20, MIN_VIDEO_DURATION_SECONDS)).toMatch(/20 second/);
  });
});
