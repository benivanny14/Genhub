// =============================================================================
// GENHUB - Bunny's animated preview as the automatic intro
//
// The thing this file exists to prevent: signing the video FOLDER
// (`/{guid}/`) to fetch `preview.webp`. Bunny opens every path under a folder it
// signed, so that token would also open `playlist.m3u8` — and the "intro" would
// quietly be the whole scene, free, to anybody who read the network tab. The
// URL must sign the file.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const bunny = vi.hoisted(() => ({
  libraryId: "760553",
  apiKey: "test-stream-key",
  storageZone: "",
  storageAccessKey: "",
  cdnHostname: "genhub-test.b-cdn.net",
  tokenSecret: "test-token-secret",
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, bunny } };
});

import { resolveIntroPreviewUrl, introPreviewPath, INTRO_PREVIEW_MINUTES } from "@/lib/bunny";

const GUID = "39ea50b0-bee6-4175-90fe-99710ecc3848";

/** base64url( SHA256(secret + path + expires) ) — what this pull zone accepts. */
const expectedToken = (path: string, expires: number) =>
  createHash("sha256")
    .update(`${bunny.tokenSecret}${path}${expires}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

beforeEach(() => {
  bunny.cdnHostname = "genhub-test.b-cdn.net";
  bunny.tokenSecret = "test-token-secret";
  bunny.apiKey = "test-stream-key";
  bunny.libraryId = "760553";
});

describe("resolveIntroPreviewUrl", () => {
  it("signs Bunny's animated preview for a Bunny-hosted row", () => {
    const url = resolveIntroPreviewUrl({ bunnyVideoId: GUID });
    expect(url).toBeTruthy();

    const parsed = new URL(url!);
    expect(parsed.host).toBe("genhub-test.b-cdn.net");
    expect(parsed.pathname).toBe(`/${GUID}/preview.webp`);
    expect(parsed.searchParams.get("expires")).toBeTruthy();

    const expires = Number(parsed.searchParams.get("expires"));
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(parsed.searchParams.get("token")).toBe(
      expectedToken(`/${GUID}/preview.webp`, expires)
    );
  });

  it("signs the FILE, never the folder — a folder token opens the scene too", () => {
    const path = new URL(resolveIntroPreviewUrl({ bunnyVideoId: GUID })!).pathname;
    expect(path.endsWith("/preview.webp")).toBe(true);
    expect(path).not.toBe(`/${GUID}/`);
    expect(path).not.toContain("playlist");
    expect(path).not.toContain("original");
  });

  it("expires on its own clock", () => {
    const expires = Number(
      new URL(resolveIntroPreviewUrl({ bunnyVideoId: GUID })!).searchParams.get("expires")
    );
    const now = Math.floor(Date.now() / 1000);
    expect(expires - now).toBeGreaterThan(INTRO_PREVIEW_MINUTES * 60 - 60);
    expect(expires - now).toBeLessThanOrEqual(INTRO_PREVIEW_MINUTES * 60);
  });

  it("returns null rather than throwing for rows Bunny does not host", () => {
    expect(resolveIntroPreviewUrl({ previewUrl: "https://example.com/a.mp4" })).toBeNull();
    expect(resolveIntroPreviewUrl({ bunnyVideoId: null })).toBeNull();
  });

  it("returns null when the library is not configured", () => {
    bunny.tokenSecret = "";
    expect(resolveIntroPreviewUrl({ bunnyVideoId: GUID })).toBeNull();

    bunny.tokenSecret = "test-token-secret";
    bunny.cdnHostname = "";
    expect(resolveIntroPreviewUrl({ bunnyVideoId: GUID })).toBeNull();
  });
});

// =============================================================================
// The URL the BROWSER is given.
//
// It must be our own route, never the CDN: this pull zone refuses any request
// carrying a Referer (403), and a browser always sends one for an <img>, so a
// direct CDN URL works in curl and breaks in the page.
// =========================================================================

describe("introPreviewPath", () => {
  it("points the client at our own route, not the CDN", () => {
    const path = introPreviewPath({ id: "row-1", bunnyVideoId: GUID });
    expect(path).toBe("/api/videos/row-1/intro");
    expect(path).not.toContain("b-cdn.net");
  });

  it("encodes a row id that needs it", () => {
    expect(introPreviewPath({ id: "a b/c", bunnyVideoId: GUID })).toBe(
      "/api/videos/a%20b%2Fc/intro"
    );
  });

  it("returns null for rows that cannot be proxied", () => {
    // No Bunny host, so no animation exists.
    expect(introPreviewPath({ id: "row-1", previewUrl: "https://x/a.mp4" })).toBeNull();
    // Demo rows carry a fabricated id and must never be asked of the CDN.
    expect(introPreviewPath({ id: "demo-1", bunnyVideoId: "demo-1" })).toBeNull();
    // Nothing to key the route on.
    expect(introPreviewPath({ bunnyVideoId: GUID })).toBeNull();
  });
});
