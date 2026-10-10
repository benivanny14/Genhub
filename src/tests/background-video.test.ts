// =============================================================================
// GENHUB - Tests for the shared background-video rules
//
// Every rule the admin's upload button and the layer that plays the result
// both depend on. The ones worth naming:
//
//   * the ceiling is exactly 500 MB, because the interface says "500 MB" and a
//     label that disagrees with the number is a label people cannot act on. It is
//     reachable ONLY because the clip no longer travels through a function: the
//     browser PUTs it straight to R2, so the deployment's 4.5 MB payload limit
//     bounds the slice this app RETURNS, never the size of the clip;
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
  backgroundVideoStoreFailure,
  backgroundVideoUploadFailure,
  backgroundVideoUrl,
  isBackgroundToken,
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
  it("is 500 MB in bytes, not 500 million", () => {
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(524_288_000);
  });

  it("is labelled the way the interface says it", () => {
    expect(MAX_BACKGROUND_VIDEO_LABEL).toBe("500 MB");
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBe(500 * 1024 * 1024);
  });

  // The clip is 500 MB and the deployment refuses a function's response body
  // past 4.5 MB — so the two numbers no longer belong to the same request. The
  // clip is uploaded straight to R2 (nothing large passes through the app) and
  // served in SLICES, and it is the slice that has to stay inside the limit.
  it("lets the clip exceed the payload limit while every response slice stays inside it", () => {
    const PAYLOAD_LIMIT = 4.5 * 1024 * 1024;
    expect(MAX_BACKGROUND_VIDEO_BYTES).toBeGreaterThan(PAYLOAD_LIMIT);
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

  // The token names the object, so anything that is not exactly what this app
  // generated must be refused.
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
  it("answers with the token, which is what the object's key is built from", () => {
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

  // It ends up in a Content-Disposition header and in the object's key, so a
  // type we do not store has to contribute nothing rather than whatever it
  // happens to contain.
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
    expect(reason).toContain("500 MB");
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
  // This one reads the answers to the requests that go to THIS app. It has to
  // name the same ceiling the picker enforced, because the platform's own 413
  // carries no sentence of ours to show.
  it("names the ceiling for the 413 the platform sends", () => {
    expect(backgroundVideoUploadFailure(413)).toContain("500 MB");
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

describe("backgroundVideoStoreFailure", () => {
  // A different failure with a different fix: the PUT goes straight to the
  // bucket, so a 401/403 there is a signature that was refused or has expired —
  // telling the operator to sign in again would send them to fix the wrong
  // thing.
  it("says the upload link was refused rather than that the session ended", () => {
    expect(backgroundVideoStoreFailure(401)).toContain("upload link");
    expect(backgroundVideoStoreFailure(403)).toContain("upload link");
    expect(backgroundVideoStoreFailure(403)).not.toContain("Sign in");
  });

  it("still names the ceiling when storage itself answers 413", () => {
    expect(backgroundVideoStoreFailure(413)).toContain("500 MB");
  });

  it("reads a statusless failure as a connection to check", () => {
    expect(backgroundVideoStoreFailure(0)).toContain("connection");
    expect(backgroundVideoStoreFailure(500)).toContain("connection");
  });
});
