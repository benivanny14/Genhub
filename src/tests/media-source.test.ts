// =============================================================================
// GENHUB - Media source resolution (bunnyVideoId wins over previewUrl)
//
// Locks in the fix for a precedence bug that shipped in five places at once.
// Every route chose its URL with `previewUrl || somethingFromBunny`, so:
//
//   - a row that had BOTH a Bunny id and a previewUrl handed the PUBLIC,
//     UNSIGNED, never-expiring previewUrl to a paying viewer instead of the
//     signed URL for the scene they bought, and
//   - the same public URL went to viewers with no entitlement at all.
//
// The deeper consequence: ordering previewUrl first meant the row's Bunny id was
// never reached, so playback was NOT token-signed even on a fully configured
// library. The anti-piracy signature existed and was simply bypassed.
//
// `previewUrl` is not a teaser — it is used as the buyer's playback URL, so it is
// the same media by another transport. The rule is therefore "the signed Bunny
// URL wins whenever it can be produced, and the stored stream is the fallback",
// expressed once in resolvePlaybackUrl / resolveTeaserUrl / resolveDownloadUrl
// instead of five times inline in route handlers where it drifted.
//
// Asserted here:
//   1. playback with both fields -> the SIGNED Bunny URL (never previewUrl)
//   2. teaser with both fields   -> the signed Bunny teaser (never previewUrl)
//   3. download with both fields -> the signed Bunny MP4 (never previewUrl)
//   4. with Bunny unconfigured, previewUrl is the fallback (demo content keeps
//      playing) and a row with no media reports a named reason
//   5. the Bunny URL is actually signed (token + expires) and uses playlist.m3u8
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";

const CDN = "vz-test-pullzone.b-cdn.net";
const TOKEN_SECRET = "b".repeat(48);
const PREVIEW = "https://example.test/public-unsigned-preview.m3u8";

async function loadBunny(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import("@/lib/bunny");
  } finally {
    process.env = saved;
    vi.resetModules();
  }
}

const CONFIGURED = {
  BUNNY_CDN_HOSTNAME: CDN,
  BUNNY_TOKEN_SECRET: TOKEN_SECRET,
};

const BUNNY_ID = "abc-123-def";
const TEASER_ID = "teaser-999-xyz";
const TEASER_CLIP = "https://example.test/trailer-clip.m3u8";
const BOTH = { bunnyVideoId: BUNNY_ID, previewUrl: PREVIEW, price: 5000 };

afterEach(() => vi.resetModules());

describe("resolvePlaybackUrl", () => {
  it("returns the signed Bunny URL when a row has both a Bunny id and a previewUrl", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolvePlaybackUrl(BOTH, 10, "viewer-1");

    expect(url).toBeTruthy();
    expect(url).not.toBe(PREVIEW);
    expect(url).toContain(CDN);
    // The bug this replaces: the public asset must never be the answer.
    expect(url).not.toContain("example.test");
  });

  it("signs the FULL playlist for the video, not the preview asset", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolvePlaybackUrl(BOTH)!;
    expect(url).toContain(`/${BUNNY_ID}/playlist.m3u8`);
  });

  it("still serves previewUrl when the row has no Bunny id (demo / side-loaded)", async () => {
    const bunny = await loadBunny(CONFIGURED);
    expect(bunny.resolvePlaybackUrl({ bunnyVideoId: null, previewUrl: PREVIEW })).toBe(PREVIEW);
  });

  it("returns null when the row has neither source", async () => {
    const bunny = await loadBunny(CONFIGURED);
    expect(bunny.resolvePlaybackUrl({ bunnyVideoId: null, previewUrl: null })).toBeNull();
  });

  // Demo rows carry a fabricated `demo-*` id (bunnyVideoId is non-nullable in the
  // schema), so an unconfigured library MUST still resolve to the stored stream —
  // otherwise nothing in the demo site plays at all.
  it("falls back to the stored stream when the Bunny library is unconfigured", async () => {
    const bunny = await loadBunny({
      BUNNY_CDN_HOSTNAME: undefined,
      BUNNY_TOKEN_SECRET: undefined,
    });
    expect(bunny.resolvePlaybackUrl(BOTH, 10, "viewer-1")).toBe(PREVIEW);
  });

  // A buyer must always get the SCENE, never the trailer, even when one exists.
  it("ignores the teaser clip when resolving the buyer's playback URL", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolvePlaybackUrl(
      { bunnyVideoId: BUNNY_ID, teaserBunnyVideoId: TEASER_ID, previewUrl: null },
      10,
      "viewer-1"
    )!;

    expect(url).toContain(`/${BUNNY_ID}/playlist.m3u8`);
    expect(url).not.toContain(TEASER_ID);
  });

  // The ordering is what matters: given a working library, the signed URL must
  // win even though a stored URL is present.
  it("prefers the signed URL over the stored one whenever signing is possible", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolvePlaybackUrl(BOTH, 10, "viewer-1")!;
    expect(url).toContain("token=");
    expect(url).not.toBe(PREVIEW);
  });
});

// The core of the teaser feature. A Bunny token authorises a PATH and cannot
// limit duration, so signing a paid scene's own playlist for a non-buyer hands
// over the whole scene. The only genuine preview is a DIFFERENT asset, which is
// what teaserBunnyVideoId holds — and when there is none, the answer is silence
// rather than the main stream.
describe("resolveTeaserUrl", () => {
  it("signs the SEPARATE teaser clip, never the scene itself", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolveTeaserUrl({
      bunnyVideoId: BUNNY_ID,
      teaserBunnyVideoId: TEASER_ID,
      previewUrl: PREVIEW,
      price: 5000,
    })!;

    expect(url).toContain(`/${TEASER_ID}/playlist.m3u8`);
    // Neither the scene nor the stored public stream may leak through.
    expect(url).not.toContain(BUNNY_ID);
    expect(url).not.toContain("example.test");
  });

  /** The `expires` value out of the path-based token form. */
  const expiresOf = (url: URL) => Number(url.pathname.match(/expires=(\d+)/)?.[1] ?? 0);

  it("signs the teaser with a shorter expiry than playback", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const teaser = new URL(bunny.resolveTeaserUrl({ teaserBunnyVideoId: TEASER_ID })!);
    const playback = new URL(bunny.resolvePlaybackUrl({ bunnyVideoId: BUNNY_ID })!);

    expect(expiresOf(teaser)).toBeLessThan(expiresOf(playback));
  });

  it("withholds a PAID scene that has no teaser clip rather than previewing it", async () => {
    const bunny = await loadBunny(CONFIGURED);

    expect(bunny.resolveTeaserUrl(BOTH)).toBeNull();
    // Not even the stored stream: a demo/migrated row's previewUrl IS the scene.
    expect(bunny.resolveTeaserUrl({ bunnyVideoId: null, previewUrl: PREVIEW, price: 5000 })).toBeNull();
  });

  // Side-loaded rows have no Bunny id, so they need their own way to offer a
  // trailer — otherwise demo and migrated content can only show the whole scene
  // or nothing at all.
  it("uses the stored trailer for a side-loaded paid scene", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolveTeaserUrl({
      bunnyVideoId: null,
      previewUrl: PREVIEW,
      teaserClipUrl: TEASER_CLIP,
      price: 5000,
    });

    expect(url).toBe(TEASER_CLIP);
    // The scene must not be reachable through the teaser slot.
    expect(url).not.toBe(PREVIEW);
  });

  it("prefers the signed Bunny teaser over a stored trailer when both exist", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolveTeaserUrl({
      bunnyVideoId: BUNNY_ID,
      teaserBunnyVideoId: TEASER_ID,
      teaserClipUrl: TEASER_CLIP,
      price: 5000,
    })!;

    expect(url).toContain(CDN);
    expect(url).not.toBe(TEASER_CLIP);
  });

  it("falls back to the stored trailer when the Bunny library cannot sign", async () => {
    const bunny = await loadBunny({
      BUNNY_CDN_HOSTNAME: undefined,
      BUNNY_TOKEN_SECRET: undefined,
    });
    const url = bunny.resolveTeaserUrl({
      bunnyVideoId: BUNNY_ID,
      teaserBunnyVideoId: TEASER_ID,
      teaserClipUrl: TEASER_CLIP,
      price: 5000,
    });

    expect(url).toBe(TEASER_CLIP);
  });

  // A trailer on a free video should still win over the video itself: the
  // creator asked for that clip to represent the scene.
  it("prefers a trailer over the full video even when the video is free", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = bunny.resolveTeaserUrl({
      bunnyVideoId: BUNNY_ID,
      teaserClipUrl: TEASER_CLIP,
      price: 0,
    });

    expect(url).toBe(TEASER_CLIP);
  });

  // A free video has nothing to protect, and withholding it would just break the
  // free experience it exists to provide.
  it("lets a free video preview itself", async () => {
    const bunny = await loadBunny(CONFIGURED);

    expect(bunny.resolveTeaserUrl({ bunnyVideoId: BUNNY_ID, price: 0 })).toContain(
      `/${BUNNY_ID}/playlist.m3u8`
    );
    expect(bunny.resolveTeaserUrl({ bunnyVideoId: null, previewUrl: PREVIEW, price: 0 })).toBe(
      PREVIEW
    );
  });

  it("returns null when the row has no media at all", async () => {
    const bunny = await loadBunny(CONFIGURED);
    expect(bunny.resolveTeaserUrl({ bunnyVideoId: null, previewUrl: null, price: 1000 })).toBeNull();
  });
});

describe("resolveDownloadUrl", () => {
  it("returns a signed MP4 rendition when a row has both sources", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const { url, unavailableReason } = bunny.resolveDownloadUrl(BOTH, "1080p", 10, "viewer-1");

    expect(unavailableReason).toBeNull();
    expect(url).toContain(`/${BUNNY_ID}/play_1080p.mp4`);
    expect(url).not.toContain("example.test");
  });

  it("honours the requested quality", async () => {
    const bunny = await loadBunny(CONFIGURED);
    expect(bunny.resolveDownloadUrl(BOTH, "720p").url).toContain("play_720p.mp4");
  });

  it("reports a named reason when a Bunny-hosted row cannot sign and has no fallback", async () => {
    const bunny = await loadBunny({ BUNNY_CDN_HOSTNAME: undefined, BUNNY_TOKEN_SECRET: undefined });
    const result = bunny.resolveDownloadUrl(
      { bunnyVideoId: BUNNY_ID, previewUrl: null },
      "1080p",
      10,
      "viewer-1"
    );

    expect(result.url).toBeNull();
    expect(result.unavailableReason).toBe("BUNNY_NOT_CONFIGURED");
  });

  it("does not claim a deployment fault when the row simply has no media", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const result = bunny.resolveDownloadUrl({ bunnyVideoId: null, previewUrl: null });
    expect(result).toEqual({ url: null, unavailableReason: null });
  });

  it("falls back to previewUrl for side-loaded content", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const result = bunny.resolveDownloadUrl({ bunnyVideoId: null, previewUrl: PREVIEW });
    expect(result).toEqual({ url: PREVIEW, unavailableReason: null });
  });
});

describe("signed URLs are actually signed", () => {
  it("includes token + expires, and refuses to sign at all without a token secret", async () => {
    const bunny = await loadBunny(CONFIGURED);
    const url = new URL(bunny.resolvePlaybackUrl(BOTH, 10, "viewer-1")!);

    // The token lives in the PATH, with the folder it authorises — not in the
    // query string, which the HLS player would drop for every segment request.
    const match = url.pathname.match(
      /^\/bcdn_token=([^&]+)&expires=(\d+)&token_path=([^/]+)\//
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBeTruthy();
    expect(Number(match![2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(decodeURIComponent(match![3])).toBe(`/${BUNNY_ID}/`);
    // No query string at all: Bunny folds every query parameter into the
    // signature, so an extra one (the old `uid` fingerprint) would invalidate it.
    expect(url.search).toBe("");
  });

  // Without BUNNY_TOKEN_SECRET the old code signed with an empty key, producing
  // a URL that LOOKED protected while any caller could forge the same signature.
  it("never signs with an empty key — nothing Bunny-shaped is produced", async () => {
    const bunny = await loadBunny({ BUNNY_CDN_HOSTNAME: CDN, BUNNY_TOKEN_SECRET: undefined });

    const playback = bunny.resolvePlaybackUrl(BOTH, 10, "viewer-1")!;
    expect(playback).not.toContain(CDN);
    expect(playback).toBe(PREVIEW);

    // A paid scene cannot be previewed without a signer, so the teaser is
    // withheld outright rather than falling back to the scene itself.
    expect(bunny.resolveTeaserUrl(BOTH)).toBeNull();
  });

  it("returns no download URL when a Bunny row has neither a signer nor a fallback", async () => {
    const bunny = await loadBunny({ BUNNY_CDN_HOSTNAME: CDN, BUNNY_TOKEN_SECRET: undefined });
    const result = bunny.resolveDownloadUrl({ bunnyVideoId: BUNNY_ID, previewUrl: null });
    expect(result.url).toBeNull();
    expect(result.unavailableReason).toBe("BUNNY_NOT_CONFIGURED");
  });
});
