// =============================================================================
// GENHUB - Tests for the shared background-video rules
//
// Every rule the admin's upload button and the layer that plays the result
// both depend on. The ones worth naming:
//
//   * the ceiling is exactly 800 MB, because the interface says "800 MB" and a
//     label that disagrees with the number is a label people cannot act on;
//   * the token is the whole security boundary on the path — 24 hex, nothing
//     else, so a row that names `../../something` resolves to "no file" rather
//     than to a path of the row's choosing;
//   * the extension comes from an allowlisted MIME, never from the filename.
//
// No database, no network, no disk: this module is imported by client
// components and is pure string and byte work by design.
// =============================================================================

import { describe, it, expect } from "vitest";

import {
  BACKGROUND_VIDEO_ACCEPT,
  BACKGROUND_VIDEO_TYPES,
  MAX_BACKGROUND_VIDEO_BYTES,
  MAX_BACKGROUND_VIDEO_LABEL,
  NO_BACKGROUND_VIDEO,
  backgroundVideoRefusal,
  backgroundVideoRelativePath,
  backgroundVideoUrl,
  isBackgroundToken,
  looksLikeBackgroundVideo,
  resolveBackgroundType,
} from "@/lib/background-video";

const TOKEN = "0123456789abcdef01234567";

function active(overrides: Partial<typeof NO_BACKGROUND_VIDEO> = {}) {
  return {
    ...NO_BACKGROUND_VIDEO,
    active: true,
    token: TOKEN,
    mimeType: "video/mp4",
    name: "hero.mp4",
    size: 1024,
    ...overrides,
  };
}

describe("the ceiling", () => {
  it("is 800 MB in bytes, not 800 million", () => {
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(800 * 1024 * 1024);
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(838_860_800);
  });

  it("is labelled the way the interface says it", () => {
    expect(MAX_BACKGROUND_VIDEO_LABEL).toBe("800 MB");
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(800 * 1024 * 1024);
  });

  it("offers a file picker the four containers we can actually play", () => {
    for (const type of ["video/mp4", "video/webm", "video/quicktime"]) {
      expect(BACKGROUND_VIDEO_ACCEPT).toContain(type);
    }
    for (const ext of [".mp4", ".webm", ".mov", ".mkv"]) {
      expect(BACKGROUND_VIDEO_ACCEPT).toContain(ext);
    }
    expect(BACKGROUND_VIDEO_TYPES["video/x-matroska"]).toBe(".mkv");
  });
});

describe("isBackgroundToken", () => {
  it("accepts the 24 hex characters the route generates", () => {
    expect(isBackgroundToken(TOKEN)).toBe(true);
    expect(isBackgroundToken("ffffffffffffffffffffffff")).toBe(true);
  });

  // The token is interpolated into the path the file is opened from, so
  // anything that is not exactly what this app generated must be refused.
  it("refuses everything that could be a path", () => {
    expect(isBackgroundToken("")).toBe(false);
    expect(isBackgroundToken("0123456789abcdef0123456789")).toBe(false);
    expect(isBackgroundToken("0123456789ABCDEF01234567")).toBe(false);
    expect(isBackgroundToken("../../../etc/passwd")).toBe(false);
    expect(isBackgroundToken("0123456789abcdef0123456g")).toBe(false);
    expect(isBackgroundToken(null)).toBe(false);
    expect(isBackgroundToken(undefined)).toBe(false);
    expect(isBackgroundToken(1234)).toBe(false);
    expect(isBackgroundToken({ token: TOKEN })).toBe(false);
  });
});

describe("backgroundVideoUrl", () => {
  it("points at the serving route with the token as the version", () => {
    expect(backgroundVideoUrl(active())).toBe(
      `/api/site/background-video?v=${TOKEN}`
    );
  });

  it("is empty when there is nothing to play", () => {
    expect(backgroundVideoUrl(NO_BACKGROUND_VIDEO)).toBe("");
    expect(backgroundVideoUrl(null)).toBe("");
    expect(backgroundVideoUrl(undefined)).toBe("");
    expect(backgroundVideoUrl(active({ active: false }))).toBe("");
  });

  // An empty URL is what makes the layer return null instead of requesting an
  // address that cannot answer.
  it("is empty when the row cannot name a file", () => {
    expect(backgroundVideoUrl(active({ token: "../../etc" }))).toBe("");
    expect(backgroundVideoUrl(active({ mimeType: "text/html" }))).toBe("");
  });
});

describe("backgroundVideoRelativePath", () => {
  it("builds the path from the token and an allowlisted extension only", () => {
    expect(backgroundVideoRelativePath(active())).toBe(
      `public/uploads/site/background-${TOKEN}.mp4`
    );
    expect(
      backgroundVideoRelativePath(active({ mimeType: "video/x-matroska" }))
    ).toBe(`public/uploads/site/background-${TOKEN}.mkv`);
  });

  it("refuses a row that could walk out of the directory", () => {
    expect(backgroundVideoRelativePath(active({ token: "../../evil" }))).toBe(null);
    expect(backgroundVideoRelativePath(active({ mimeType: "text/html" }))).toBe(null);
    expect(backgroundVideoRelativePath(null)).toBe(null);
    expect(backgroundVideoRelativePath(undefined)).toBe(null);
  });
});

describe("resolveBackgroundType", () => {
  it("trusts a MIME type we allowlist", () => {
    expect(resolveBackgroundType("video/mp4", "x.bin")).toEqual({
      mimeType: "video/mp4",
      extension: ".mp4",
    });
    expect(resolveBackgroundType("video/quicktime", "")).toEqual({
      mimeType: "video/quicktime",
      extension: ".mov",
    });
  });

  it("ignores a charset suffix and any casing", () => {
    expect(resolveBackgroundType("Video/MP4; charset=binary", "x")).toEqual({
      mimeType: "video/mp4",
      extension: ".mp4",
    });
  });

  // file.type is empty for a good number of files dragged off a file manager,
  // and refusing a real MP4 because its picker had no opinion is the same bug
  // the image route already fixed for pictures.
  it("falls back to the extension when the browser said nothing useful", () => {
    expect(resolveBackgroundType("", "holiday.MP4")).toEqual({
      mimeType: "video/mp4",
      extension: ".mp4",
    });
    expect(resolveBackgroundType("", "clip.mkv")).toEqual({
      mimeType: "video/x-matroska",
      extension: ".mkv",
    });
    expect(resolveBackgroundType("", "movie.m4v")).toEqual({
      mimeType: "video/mp4",
      extension: ".mp4",
    });
  });

  it("refuses a type that is not one of the four", () => {
    expect(resolveBackgroundType("text/html", "index.html")).toBe(null);
    expect(resolveBackgroundType("video/x-msvideo", "clip.avi")).toBe(null);
    expect(resolveBackgroundType("", "notes.txt")).toBe(null);
    expect(resolveBackgroundType("", "")).toBe(null);
  });
});

describe("backgroundVideoRefusal", () => {
  it("lets a normal clip through", () => {
    expect(
      backgroundVideoRefusal({ size: 5_000_000, type: "video/mp4", name: "a.mp4" })
    ).toBe(null);
  });

  it("names the ceiling exactly, and before a byte leaves the device", () => {
    const reason = backgroundVideoRefusal({
      size: MAX_BACKGROUND_VIDEO_BYTES + 1,
      type: "video/mp4",
      name: "a.mp4",
    });
    expect(reason).toContain("800 MB");
  });

  it("refuses an empty file and a file that is not a video", () => {
    expect(backgroundVideoRefusal({ size: 0, type: "video/mp4", name: "a.mp4" })).toBe(
      "That file is empty."
    );
    expect(backgroundVideoRefusal({ size: 10, type: "text/plain", name: "a.txt" })).toContain(
      "not a video"
    );
  });
});

describe("looksLikeBackgroundVideo", () => {
  // 4 bytes of box length, then "ftyp".
  const mp4Head = Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73]);
  // The EBML header every Matroska container opens with.
  const ebmlHead = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74]);

  it("accepts a real MP4 and MOV", () => {
    expect(looksLikeBackgroundVideo(mp4Head, ".mp4")).toBe(true);
    expect(looksLikeBackgroundVideo(mp4Head, ".mov")).toBe(true);
  });

  it("accepts the Matroska family", () => {
    expect(looksLikeBackgroundVideo(ebmlHead, ".webm")).toBe(true);
    expect(looksLikeBackgroundVideo(ebmlHead, ".mkv")).toBe(true);
  });

  // The MIME type and the extension are both claims. These are the bytes.
  it("refuses text wearing a video's name", () => {
    const text = new TextEncoder().encode("hello, this is not a video at all");
    expect(looksLikeBackgroundVideo(text, ".mp4")).toBe(false);
    expect(looksLikeBackgroundVideo(text, ".webm")).toBe(false);
  });

  it("refuses a head too short to contain the marker", () => {
    expect(looksLikeBackgroundVideo(Uint8Array.from([0, 0, 0]), ".mp4")).toBe(false);
    expect(looksLikeBackgroundVideo(new Uint8Array(0), ".webm")).toBe(false);
  });

  it("refuses an extension it has no marker for", () => {
    expect(looksLikeBackgroundVideo(mp4Head, ".avi")).toBe(false);
    expect(looksLikeBackgroundVideo(mp4Head, "")).toBe(false);
  });
});
