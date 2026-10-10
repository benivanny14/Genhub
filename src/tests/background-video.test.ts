// =============================================================================
// GENHUB - Tests for the shared background-video rules
//
// Every rule the admin's upload button and the layer that plays the result
// both depend on. The ones worth naming:
//
//   * the ceiling is exactly 4 MB, because the interface says "4 MB" and a label
//     that disagrees with the number is a label people cannot act on — and
//     because that number is what keeps a clip inside the deployment's payload
//     limit in both directions;
//   * the token is the whole security boundary on the bytes — 24 hex, nothing
//     else, so a row that names `../../something` resolves to "no clip" rather
//     than to a key of the row's choosing;
//   * the extension comes from an allowlisted MIME, never from the filename.
//
// No database, no network, no disk: this module is imported by client
// components and is pure string, number and byte work by design.
// =============================================================================

import { describe, it, expect } from "vitest";

import {
  BACKGROUND_VIDEO_ACCEPT,
  BACKGROUND_VIDEO_TYPES,
  MAX_BACKGROUND_VIDEO_BYTES,
  MAX_BACKGROUND_VIDEO_LABEL,
  MAX_BACKGROUND_VIDEO_SLICE_BYTES,
  NO_BACKGROUND_VIDEO,
  backgroundVideoAssetId,
  backgroundVideoExtension,
  backgroundVideoRefusal,
  backgroundVideoUploadFailure,
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
  it("is 4 MB in bytes, not 4 million", () => {
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(4_194_304);
  });

  it("is labelled the way the interface says it", () => {
    expect(MAX_BACKGROUND_VIDEO_LABEL).toBe("4 MB");
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(4 * 1024 * 1024);
  });

  // A clip travels through a serverless function in BOTH directions, and the
  // platform refuses a request or a response body over 4.5 MB. One number decides
  // both halves, so one assertion keeps them inside it.
  it("and every response slice stay inside the deployment's payload limit", () => {
    const PAYLOAD_LIMIT = 4.5 * 1024 * 1024;
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBeLessThan(PAYLOAD_LIMIT);
    expect(MAX_BACKGROUND_VIDEO_SLICE_BYTES).toBeLessThan(PAYLOAD_LIMIT);
    expect(MAX_BACKGROUND_VIDEO_SLICE_BYTES).toBeGreaterThan(0);
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

describe("backgroundVideoAssetId", () => {
  it("answers with the token, which is the key the bytes are stored under", () => {
    expect(backgroundVideoAssetId(active())).toBe(TOKEN);
    expect(backgroundVideoAssetId(active({ mimeType: "video/x-matroska" }))).toBe(TOKEN);
  });

  it("refuses a row that could address something we did not store", () => {
    expect(backgroundVideoAssetId(active({ token: "../../evil" }))).toBe(null);
    expect(backgroundVideoAssetId(active({ mimeType: "text/html" }))).toBe(null);
    expect(backgroundVideoAssetId(null)).toBe(null);
    expect(backgroundVideoAssetId(undefined)).toBe(null);
  });
});

describe("backgroundVideoExtension", () => {
  it("names the file a stored clip is served as", () => {
    expect(backgroundVideoExtension("video/mp4")).toBe(".mp4");
    expect(backgroundVideoExtension("video/x-matroska")).toBe(".mkv");
  });

  // It ends up in a Content-Disposition header, so a type we do not store has to
  // contribute nothing to the name rather than whatever it happens to contain.
  it("contributes nothing for a type we do not store", () => {
    expect(backgroundVideoExtension("text/html")).toBe("");
    expect(backgroundVideoExtension("")).toBe("");
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
      backgroundVideoRefusal({ size: 1_200_000, type: "video/mp4", name: "a.mp4" })
    ).toBe(null);
  });

  it("names the ceiling exactly, and before a byte leaves the device", () => {
    const reason = backgroundVideoRefusal({
      size: MAX_BACKGROUND_VIDEO_BYTES + 1,
      type: "video/mp4",
      name: "a.mp4",
    });
    expect(reason).toContain("4 MB");
  });

  it("accepts a clip exactly at the ceiling", () => {
    expect(
      backgroundVideoRefusal({
        size: MAX_BACKGROUND_VIDEO_BYTES,
        type: "video/mp4",
        name: "a.mp4",
      })
    ).toBe(null);
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

describe("backgroundVideoUploadFailure", () => {
  // A body over the deployment's own payload limit is refused by the platform
  // before the route runs, and its answer is not JSON — so there is no sentence
  // of ours to show and the status is the only fact available. It has to name the
  // same ceiling the picker enforced.
  it("names the ceiling for the 413 the platform sends", () => {
    expect(backgroundVideoUploadFailure(413)).toContain("4 MB");
  });

  it("tells an operator to sign in again rather than to retry", () => {
    expect(backgroundVideoUploadFailure(401)).toContain("Sign in");
    expect(backgroundVideoUploadFailure(403)).toContain("Sign in");
  });

  it("explains a rate limit", () => {
    expect(backgroundVideoUploadFailure(429)).toContain("Too many uploads");
  });

  it("speaks about the server, not about the operator's file, for a 5xx", () => {
    expect(backgroundVideoUploadFailure(503)).toContain("server");
  });

  it("falls back to a sentence that at least says to retry", () => {
    expect(backgroundVideoUploadFailure(0)).toContain("try again");
    expect(backgroundVideoUploadFailure(400)).toContain("try again");
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
