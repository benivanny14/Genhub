// =============================================================================
// GENHUB - Video trim helpers
// =============================================================================
// The trimmer feeds these numbers straight into MediaRecorder, so a bad range
// is not a cosmetic bug — it is an empty or truncated file the creator only
// discovers after the upload finished. These tests pin the boundary rules.

import { describe, it, expect } from "vitest";
import {
  MIN_TRIM_SECONDS,
  baseMimeType,
  clampTrimRange,
  exportCanvasSize,
  extensionForMime,
  formatTimecode,
  isFullRange,
  outputFileName,
  pickTrimMimeType,
  recordingBitsPerSecond,
  trimDuration,
} from "@/lib/video-trim";

describe("clampTrimRange", () => {
  it("keeps a valid range untouched", () => {
    expect(clampTrimRange({ start: 3, end: 9 }, 20)).toEqual({ start: 3, end: 9 });
  });

  it("returns an empty range when the duration is unknown", () => {
    expect(clampTrimRange({ start: 3, end: 9 }, 0)).toEqual({ start: 0, end: 0 });
    expect(clampTrimRange({ start: 3, end: 9 }, NaN)).toEqual({ start: 0, end: 0 });
  });

  it("pulls the end inside the source", () => {
    expect(clampTrimRange({ start: 5, end: 99 }, 12)).toEqual({ start: 5, end: 12 });
  });

  it("widens a reversed range to the minimum length", () => {
    // A creator dragged the end handle past the start; the range must not
    // collapse to nothing or become negative.
    const range = clampTrimRange({ start: 5, end: 3 }, 20);
    expect(range.start).toBe(5);
    expect(range.end).toBe(5 + MIN_TRIM_SECONDS);
  });

  it("honours the minimum length at the tail", () => {
    const range = clampTrimRange({ start: 19.5, end: 20 }, 20);
    expect(range.end).toBe(20);
    expect(trimDuration(range)).toBeGreaterThanOrEqual(MIN_TRIM_SECONDS);
    expect(range.start).toBe(20 - MIN_TRIM_SECONDS);
  });

  it("keeps the whole clip when it is shorter than the minimum", () => {
    expect(clampTrimRange({ start: 0, end: 0.4 }, 0.4)).toEqual({ start: 0, end: 0.4 });
  });

  it("survives NaN from a pointer position", () => {
    expect(clampTrimRange({ start: NaN, end: NaN }, 10)).toEqual({ start: 0, end: 10 });
  });
});

describe("trimDuration", () => {
  it("returns the span", () => {
    expect(trimDuration({ start: 2, end: 7.5 })).toBe(5.5);
  });

  it("never returns a negative span", () => {
    expect(trimDuration({ start: 9, end: 4 })).toBe(0);
  });
});

describe("isFullRange", () => {
  it("is true only when essentially nothing was cut", () => {
    expect(isFullRange({ start: 0, end: 30 }, 30)).toBe(true);
    expect(isFullRange({ start: 0.01, end: 29.98 }, 30)).toBe(true);
    expect(isFullRange({ start: 0, end: 25 }, 30)).toBe(false);
    expect(isFullRange({ start: 0, end: 0 }, 0)).toBe(false);
  });
});

describe("formatTimecode", () => {
  it("formats under an hour as m:ss", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(65)).toBe("1:05");
    expect(formatTimecode(600)).toBe("10:00");
  });

  it("adds an hours field past an hour", () => {
    expect(formatTimecode(3661)).toBe("1:01:01");
    expect(formatTimecode(5400)).toBe("1:30:00");
  });

  it("rounds down and tolerates junk", () => {
    expect(formatTimecode(9.9)).toBe("0:09");
    expect(formatTimecode(-4)).toBe("0:00");
    expect(formatTimecode(NaN)).toBe("0:00");
  });
});

describe("pickTrimMimeType", () => {
  it("prefers WebM/VP9 when it is offered", () => {
    expect(pickTrimMimeType((m) => m === "video/webm;codecs=vp9,opus")).toBe(
      "video/webm;codecs=vp9,opus"
    );
  });

  it("falls back to the first supported candidate", () => {
    expect(pickTrimMimeType((m) => m === "video/webm;codecs=vp8,opus")).toBe(
      "video/webm;codecs=vp8,opus"
    );
  });

  it("returns null when nothing is supported", () => {
    expect(pickTrimMimeType(() => false)).toBeNull();
  });

  it("does not let a throwing probe break detection", () => {
    const supports = (m: string) => {
      if (m.includes("vp9")) throw new Error("unknown type");
      return m === "video/webm;codecs=vp8,opus";
    };
    expect(pickTrimMimeType(supports)).toBe("video/webm;codecs=vp8,opus");
  });
});

describe("outputFileName", () => {
  it("strips the original extension and marks the cut", () => {
    expect(outputFileName("scene-01.mp4", "video/webm;codecs=vp8,opus")).toBe(
      "scene-01-trimmed.webm"
    );
  });

  it("uses mp4 when the container is mp4", () => {
    expect(outputFileName("clip.MOV", "video/mp4")).toBe("clip-trimmed.mp4");
  });

  it("copes with a name that has no extension", () => {
    expect(outputFileName("holiday", "video/webm")).toBe("holiday-trimmed.webm");
    expect(outputFileName("", "video/webm")).toBe("video-trimmed.webm");
  });
});

describe("baseMimeType", () => {
  it("drops the codecs parameter", () => {
    expect(baseMimeType("video/webm;codecs=vp9,opus")).toBe("video/webm");
  });
});

describe("extensionForMime", () => {
  it("maps the container to an extension", () => {
    expect(extensionForMime("video/webm;codecs=vp9,opus")).toBe("webm");
    expect(extensionForMime("video/mp4")).toBe("mp4");
  });
});

describe("exportCanvasSize", () => {
  it("down-scales a large frame to the cap", () => {
    expect(exportCanvasSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
  });

  it("leaves a small frame alone", () => {
    expect(exportCanvasSize(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it("forces even dimensions encoders require", () => {
    const size = exportCanvasSize(441, 249);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });

  it("assumes 16:9 when the frame size is unknown", () => {
    expect(exportCanvasSize(0, 0)).toEqual({ width: 1280, height: 720 });
  });
});

describe("recordingBitsPerSecond", () => {
  it("scales with the output height", () => {
    expect(recordingBitsPerSecond(1080)).toBeGreaterThan(recordingBitsPerSecond(720));
    expect(recordingBitsPerSecond(720)).toBeGreaterThan(recordingBitsPerSecond(360));
  });

  it("has a sane default for junk input", () => {
    expect(recordingBitsPerSecond(0)).toBeGreaterThan(0);
  });
});
