// =============================================================================
// GENHUB - Quality ladder labels and ordering
// =============================================================================
// The numbers in the first block are not invented: they are what hls.js reports
// for the one real video in the live Bunny library, whose master playlist reads
//
//   RESOLUTION=358x640  ->  360p/video.m3u8
//   RESOLUTION=198x352  ->  240p/video.m3u8
//
// (a 360x642 portrait upload). Labelling by `height` showed viewers "640p" and
// "352p" — see lib/quality.ts for why the shorter side, snapped to the standard
// ladder, is the name every other platform would use.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  buildQualityMenu,
  qualityLabelFor,
  qualityTierLabel,
} from "@/lib/quality";

describe("qualityTierLabel", () => {
  it("names a portrait rendition by its shorter side, like every other platform", () => {
    // The live library's real renditions.
    expect(qualityTierLabel({ width: 358, height: 640 }, 1)).toBe("360p");
    expect(qualityTierLabel({ width: 198, height: 352 }, 0)).toBe("240p");
  });

  it("names the standard landscape ladder exactly", () => {
    const ladder: [number, number, string][] = [
      [426, 240, "240p"],
      [640, 360, "360p"],
      [854, 480, "480p"],
      [1280, 720, "720p"],
      [1920, 1080, "1080p"],
      [2560, 1440, "1440p"],
      [3840, 2160, "2160p"],
      [256, 144, "144p"],
    ];
    for (const [width, height, expected] of ladder) {
      expect(qualityTierLabel({ width, height }, 0)).toBe(expected);
    }
  });

  it("handles a square and an oddly-sized rendition without drifting a tier", () => {
    expect(qualityTierLabel({ width: 720, height: 720 }, 0)).toBe("720p");
    // 540x960 is Bunny's 480p rendition of a tall upload, not "540p".
    expect(qualityTierLabel({ width: 540, height: 960 }, 0)).toBe("480p");
    // Only the height reported is enough to name a rendition (and it is what a
    // manifest always carries when it carries anything: RESOLUTION is "WxH").
    expect(qualityTierLabel({ height: 1080 }, 0)).toBe("1080p");
  });

  it("falls back to a placeholder when the manifest said nothing about size", () => {
    expect(qualityTierLabel({}, 0)).toBe("Level 1");
    expect(qualityTierLabel({ bitrate: 800_000 }, 2)).toBe("Level 3");
  });
});

describe("buildQualityMenu", () => {
  // Exactly how hls.js hands the levels over: ascending by bitrate, so the WORST
  // rendition arrives first.
  const parsedLikeHls = [
    { width: 198, height: 352, bitrate: 535_640 },
    { width: 358, height: 640, bitrate: 1_014_185 },
  ];

  it("lists the best rendition first and keeps the hls level index", () => {
    const menu = buildQualityMenu(parsedLikeHls);

    expect(menu).toEqual([
      { index: 1, label: "360p" },
      { index: 0, label: "240p" },
    ]);

    // The index is what chooseQuality() puts into hls.currentLevel, so selecting
    // "240p" — the last row — must still set level 0, not level 1.
    expect(menu.find((option) => option.label === "240p")?.index).toBe(0);
  });

  it("orders a full ladder best-first", () => {
    const menu = buildQualityMenu([
      { width: 426, height: 240, bitrate: 300_000 },
      { width: 1920, height: 1080, bitrate: 5_000_000 },
      { width: 640, height: 360, bitrate: 700_000 },
      { width: 1280, height: 720, bitrate: 2_500_000 },
    ]);

    expect(menu.map((option) => option.label)).toEqual([
      "1080p",
      "720p",
      "360p",
      "240p",
    ]);
  });

  it("breaks a bitrate tie on picture size so the order cannot shuffle", () => {
    const menu = buildQualityMenu([
      { width: 640, height: 360, bitrate: 900_000 },
      { width: 854, height: 480, bitrate: 900_000 },
    ]);

    expect(menu.map((option) => option.label)).toEqual(["480p", "360p"]);
  });

  it("returns an empty menu for a single-level or unknown manifest", () => {
    expect(buildQualityMenu([])).toEqual([]);
    expect(buildQualityMenu([{ width: 640, height: 360, bitrate: 700_000 }])).toEqual([
      { index: 0, label: "360p" },
    ]);
  });
});

describe("qualityLabelFor", () => {
  it("translates a live level index back into the menu label", () => {
    const menu = buildQualityMenu([
      { width: 198, height: 352, bitrate: 535_640 },
      { width: 358, height: 640, bitrate: 1_014_185 },
    ]);

    expect(qualityLabelFor(menu, 1)).toBe("360p");
    expect(qualityLabelFor(menu, 0)).toBe("240p");
  });

  it("returns null for Auto and for a level that is not in the menu", () => {
    const menu = buildQualityMenu([{ width: 358, height: 640, bitrate: 1 }]);
    expect(qualityLabelFor(menu, -1)).toBeNull();
    expect(qualityLabelFor(menu, 7)).toBeNull();
  });
});
