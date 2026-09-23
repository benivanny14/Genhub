// =============================================================================
// GENHUB - Demo trailers
//
// The demo feed is the only way to look at this product without Bunny and a
// database full of real content, so it doubles as documentation: if the demo
// leaks the full scene to non-buyers, so will any copy of it.
//
// The failure this guards against is specific and easy to reintroduce. The
// demo's main streams live in `DEMO_VIDEOS[].teaserUrl` (historical naming — the
// seed maps it to `Video.previewUrl`), and the feed maps that field to what a
// NON-BUYER may play. Wiring the two together directly would hand every paid
// demo scene to anyone who loads the homepage.
//
// Asserted here:
//   1. every demo video has a trailer
//   2. no trailer is the same URL as that video's own scene
//   3. the trailer pool and the scene pool do not overlap at all
//   4. sample.m3u8 URLs look like HLS (a typo would fail at play time, silently)
//   5. `filterDemoVideos` exposes the TRAILER, and withholds it for paid rows
//      that somehow lack one, rather than falling back to the scene
// =============================================================================

import { describe, it, expect } from "vitest";
import { DEMO_VIDEOS, demoTeaserFor, filterDemoVideos, toFeedVideo } from "@/lib/demo-data";

describe("demo trailers", () => {
  it("gives every demo video a trailer", () => {
    const missing = DEMO_VIDEOS.filter((v) => !v.teaserClipUrl).map((v) => v.id);
    expect(missing).toEqual([]);
  });

  it("never lets a trailer be the same URL as that video's own scene", () => {
    const identical = DEMO_VIDEOS.filter(
      (v) => v.teaserClipUrl && v.teaserClipUrl === v.teaserUrl
    ).map((v) => v.id);

    // If this ever fails, a non-buyer is being served the full scene as a
    // "preview" — the exact leak the teaser columns exist to close.
    expect(identical).toEqual([]);
  });

  it("keeps the trailer pool and the scene pool completely disjoint", () => {
    const scenes = new Set(DEMO_VIDEOS.map((v) => v.teaserUrl));
    const trailers = new Set(DEMO_VIDEOS.map((v) => v.teaserClipUrl));

    const overlap = Array.from(trailers).filter((t) => t && scenes.has(t));
    expect(overlap).toEqual([]);
  });

  it("uses HLS playlists for both pools (a bad URL fails silently at play time)", () => {
    for (const v of DEMO_VIDEOS) {
      expect(v.teaserUrl, `${v.id} scene`).toMatch(/\.m3u8(\?|$)/);
      expect(v.teaserClipUrl, `${v.id} trailer`).toMatch(/\.m3u8(\?|$)/);
    }
  });

  it("has more than one trailer, so the preview does not look copy-pasted", () => {
    const distinct = new Set(DEMO_VIDEOS.map((v) => v.teaserClipUrl));
    expect(distinct.size).toBeGreaterThan(1);
  });

  // The raw record's `teaserUrl` IS the scene. `toFeedVideo` is what the
  // homepage's offline fallback renders, so it must publish the TRAILER under
  // that name instead — otherwise every paid demo scene plays for free.
  it("publishes the trailer, never the raw scene, from the feed mapping", () => {
    for (const raw of DEMO_VIDEOS) {
      const feed = toFeedVideo(raw);

      expect(feed.teaserUrl, `${raw.id} feed teaser`).toBe(raw.teaserClipUrl);
      expect(feed.teaserUrl, `${raw.id} must not be the scene`).not.toBe(raw.teaserUrl);
    }
  });

  it("withholds a paid row that has no trailer instead of falling back to the scene", () => {
    const paidWithoutTrailer = {
      ...DEMO_VIDEOS[0],
      price: 5000,
      teaserClipUrl: null,
    };

    expect(demoTeaserFor(paidWithoutTrailer)).toBeNull();
    expect(toFeedVideo(paidWithoutTrailer).teaserUrl).toBeNull();
  });

  it("lets a free row preview itself when it has no trailer", () => {
    const freeWithoutTrailer = {
      ...DEMO_VIDEOS[0],
      price: 0,
      teaserClipUrl: null,
    };

    expect(demoTeaserFor(freeWithoutTrailer)).toBe(freeWithoutTrailer.playbackUrl);
  });

  // `filterDemoVideos` feeds the same fallback; it must hand back raw records
  // (trailer in teaserClipUrl) for the mapping above to convert.
  it("returns records the feed mapping can safely convert", () => {
    const feed = filterDemoVideos({});
    expect(feed.length).toBeGreaterThan(0);

    for (const v of feed.slice(0, 5)) {
      expect(v.teaserClipUrl, `${v.id} trailer missing`).toBeTruthy();
      expect(v.teaserClipUrl).not.toBe(v.teaserUrl);
    }
  });
});
