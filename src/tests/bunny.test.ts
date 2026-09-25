// =============================================================================
// GENHUB - Bunny.net URL signing
//
// Locks in three things that are easy to get silently wrong:
//   1. Bunny signs the request PATH (leading slash included), not just the id.
//      A missing slash produces a token the CDN rejects — playback breaks in
//      production while every unit test that only checks "signature exists"
//      still passes.
//   2. No token secret => THROW, never a URL signed with an empty key. An
//      unsigned "signed" URL is worse than no protection: it looks protected
//      while anyone can forge or share it.
//   3. The safe* variants used by list endpoints return null instead of
//      throwing, so one video with a Bunny id on an unconfigured library cannot
//      take down the whole feed.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash, createHmac } from "node:crypto";

const bunny = vi.hoisted(() => ({
  libraryId: "12345",
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  generateSignedVideoUrl,
  generateDownloadUrl,
  safeTeaserUrl,
  safeSignedVideoUrl,
  safeDownloadUrl,
  isBunnyConfigured,
  isBunnyPlaybackConfigured,
  createVideoUpload,
  createTusCredentials,
  getBunnyVideoDetails,
  deleteBunnyVideo,
  probeSignedPlayback,
  signedCdnQuery,
  pickAvailableQuality,
  BunnyNotConfiguredError,
} from "@/lib/bunny";

/**
 * base64url( SHA256(secret + path + expires) ) — the signature this pull zone
 * actually accepts.
 *
 * The old helper computed HMAC-SHA256 over `expires + path`, which Bunny answers
 * with a bare 403: the manifest never loaded, the player spun, and no log line
 * named the cause. Verified against the live CDN by sweeping 1200 shape
 * combinations (both orders, HMAC / SHA256 / SHA256-with-key-prefix, hex /
 * base64 / base64url, truncated and full, seconds and milliseconds, query and
 * path forms) — exactly one family answered 206, and it is this one.
 */
const expectedToken = (path: string, expires: number, secret: string) =>
  createHash("sha256")
    .update(`${secret}${path}${expires}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

beforeEach(() => {
  bunny.cdnHostname = "genhub-test.b-cdn.net";
  bunny.tokenSecret = "test-token-secret";
  bunny.apiKey = "test-stream-key";
  bunny.libraryId = "12345";
  bunny.storageZone = "";
  bunny.storageAccessKey = "";
});

// =============================================================================
// The management API host.
//
// This existed as `video.bunny.net/api/v2`, which does not resolve at all — so
// every upload, lookup and delete failed with a DNS error in production while
// the mocked tests above kept passing, because none of them asserted the host.
// These tests pin the real host, and scan the tree so it cannot come back.
// =============================================================================

/** Built at runtime so this spec cannot match itself when scanning. */
const DEAD_HOST = ["video", "bunny", "net"].join(".");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("Bunny management API host", () => {
  it("reserves the slot and returns TUS credentials signed for that one video", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ guid: "vid-1" }), { status: 200 });
      })
    );

    const result = await createVideoUpload("My scene");

    expect(calls).toEqual(["POST https://video.bunnycdn.com/library/12345/videos"]);
    expect(result.videoId).toBe("vid-1");
    expect(result.libraryId).toBe("12345");
    expect(result.endpoint).toBe("https://video.bunnycdn.com/tusupload");
    expect(result.expirationTime).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // sha256(libraryId + apiKey + expiration + videoId), per Bunny's TUS docs.
    expect(result.signature).toBe(
      createHash("sha256")
        .update(`12345test-stream-key${result.expirationTime}vid-1`)
        .digest("hex")
    );

    // The client must never receive the library API key: with it, any viewer
    // could delete or replace every video in the library.
    expect(JSON.stringify(result)).not.toContain("test-stream-key");
    vi.unstubAllGlobals();
  });

  it("refuses to sign credentials when the library is unconfigured", () => {
    const apiKey = bunny.apiKey;
    bunny.apiKey = "";
    expect(() => createTusCredentials("vid-1")).toThrow(BunnyNotConfiguredError);
    bunny.apiKey = apiKey;
  });

  it("reads and deletes on the same host", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response("{}", { status: 200 });
      })
    );

    await getBunnyVideoDetails("vid-1");
    await deleteBunnyVideo("vid-1");

    expect(calls).toEqual([
      "GET https://video.bunnycdn.com/library/12345/videos/vid-1",
      "DELETE https://video.bunnycdn.com/library/12345/videos/vid-1",
    ]);
    vi.unstubAllGlobals();
  });

  it("no CODE line in the repo points at the dead host", () => {
    // Comments are allowed to name it (this file and bunny.ts explain the bug),
    // but no executable line may fetch from it again.
    const codeLines = [...sourceFiles("src"), ...sourceFiles("scripts")]
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .map((line) => ({ file, line }))
      )
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));

    const offenders = codeLines
      .filter(({ line }) => line.includes(DEAD_HOST))
      .map(({ file, line }) => `${file}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// Bounded management calls.
//
// These run on request paths and in a cron worker, so a Bunny that accepts the
// connection and then never answers must not hold the caller open until the
// function timeout — the same failure the Redis bound was added for. Two things
// are pinned: every management call carries a timeout signal, and a timeout is
// reported by name rather than as an opaque abort.
// =============================================================================

describe("Bunny management calls are bounded", () => {
  it("signals a timeout on every management request", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Response(JSON.stringify({ guid: "vid-1" }), { status: 200 });
      })
    );

    await createVideoUpload("My scene");
    await getBunnyVideoDetails("vid-1");
    await deleteBunnyVideo("vid-1");

    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it("names the provider and the wait instead of leaking an opaque abort", async () => {
    // AbortSignal.timeout() rejects with a TimeoutError; the caller should read
    // which provider went quiet, not "The operation was aborted".
    const timedOut = new Error("The operation was aborted due to timeout");
    timedOut.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timedOut;
      })
    );

    await expect(getBunnyVideoDetails("vid-1")).rejects.toThrow(/Bunny lookup timed out/);
    vi.unstubAllGlobals();
  });
});

describe("Bunny signing", () => {
  /** The token parameters Bunny reads: the query string, nowhere else. */
  function readSignedUrl(url: URL) {
    return {
      token: url.searchParams.get("token") ?? "",
      expires: Number(url.searchParams.get("expires") ?? 0),
      path: url.pathname,
    };
  }

  it("signs the file path and puts the token in the QUERY STRING", () => {
    const url = new URL(generateSignedVideoUrl("abc-123", 10, "viewer-9"));
    const signed = readSignedUrl(url);

    expect(url.hostname).toBe("genhub-test.b-cdn.net");
    expect(signed.path).toBe("/abc-123/playlist.m3u8");
    expect(signed.token).toBe(
      expectedToken("/abc-123/playlist.m3u8", signed.expires, "test-token-secret")
    );
  });

  // The regression that cost two days of "the spinner never stops": Bunny takes
  // a plain SHA-256 over `secret + path + expires`, and refuses an HMAC over
  // `expires + path` with a 403 that names neither the key nor the hash.
  it("hashes secret + path + expires, and is not the HMAC this used to emit", () => {
    const url = new URL(generateSignedVideoUrl("abc-123", 10));
    const { token, expires } = readSignedUrl(url);

    const oldShape = createHmac("sha256", "test-token-secret")
      .update(`${expires}/abc-123/playlist.m3u8`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(token).toBe(expectedToken("/abc-123/playlist.m3u8", expires, "test-token-secret"));
    expect(token).not.toBe(oldShape);
  });

  // The `bcdn_token`/`token_path` path-prefix form is refused by this pull zone
  // even with a correct signature, so it must not come back.
  it("never emits the path-prefix token form", () => {
    const url = new URL(generateSignedVideoUrl("abc-123"));
    expect(url.pathname).not.toContain("bcdn_token");
    expect(url.pathname).not.toContain("token_path");
    expect(url.pathname).toBe("/abc-123/playlist.m3u8");
  });

  it("expires roughly `expirationMinutes` from now", () => {
    const before = Math.floor(Date.now() / 1000);
    const url = new URL(generateSignedVideoUrl("abc-123", 10));
    const expires = readSignedUrl(url).expires;
    expect(expires).toBeGreaterThanOrEqual(before + 10 * 60);
    expect(expires).toBeLessThanOrEqual(before + 10 * 60 + 2);
  });

  it("signs each download rendition for its own file path", () => {
    const url = new URL(generateDownloadUrl("abc-123", "720p", 10));
    const signed = readSignedUrl(url);
    expect(signed.path).toBe("/abc-123/play_720p.mp4");
    expect(signed.token).toBe(
      expectedToken("/abc-123/play_720p.mp4", signed.expires, "test-token-secret")
    );
  });

  // The HLS proxy signs the video's FOLDER, because a folder token is honoured
  // for every child request (manifest, renditions, segments) — measured against
  // the live zone, and the whole reason a rewritten manifest is playable.
  it("can authorise a whole folder, for exactly that folder", () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    expect(signedCdnQuery("/abc-123/", expires)).toBe(
      `token=${expectedToken("/abc-123/", expires, "test-token-secret")}&expires=${expires}`
    );
  });

  it("refuses to build a signed URL without a token secret", () => {
    bunny.tokenSecret = "";
    expect(() => generateSignedVideoUrl("abc-123")).toThrow(BunnyNotConfiguredError);
    expect(() => generateDownloadUrl("abc-123")).toThrow(BunnyNotConfiguredError);
  });

  it("refuses to build a playback URL without a CDN hostname", () => {
    bunny.cdnHostname = "";
    expect(() => generateSignedVideoUrl("abc-123")).toThrow(BunnyNotConfiguredError);
  });

  // ===========================================================================
  // Signing a real manifest, which is the only check that distinguishes
  // "the secret is set" from "the secret works".
  // ===========================================================================
  describe("probeSignedPlayback", () => {
    it("reports the key mismatch when Bunny refuses the signature", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 }) as Response));

      const result = await probeSignedPlayback("abc-123");

      expect(result.state).toBe("fail");
      // The message has to name the fix, not just the symptom: this is read by
      // whoever pasted the wrong value into BUNNY_TOKEN_SECRET.
      expect(result.detail).toMatch(/URL Token Authentication Key/);
      expect(result.detail).toMatch(/403/);
      vi.unstubAllGlobals();
    });

    it("is ok when the CDN accepts it", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 206 }) as Response));

      const result = await probeSignedPlayback("abc-123");

      expect(result.state).toBe("ok");
      expect(result.detail).toMatch(/matches the pull zone/);
      vi.unstubAllGlobals();
    });

    it("skips rather than fails when there is nothing to sign with", async () => {
      bunny.tokenSecret = "";
      const result = await probeSignedPlayback("abc-123");
      expect(result.state).toBe("skip");
    });

    it("attributes a timeout to the CDN, not to the key", async () => {
      const timedOut = new Error("aborted");
      timedOut.name = "TimeoutError";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw timedOut;
        })
      );

      const result = await probeSignedPlayback("abc-123");
      expect(result.state).toBe("fail");
      expect(result.detail).toMatch(/did not answer/);
      vi.unstubAllGlobals();
    });
  });

  // The download menu offers 1080p / 720p / 480p to every video, but Bunny only
  // keeps MP4 fallbacks for the resolutions an upload actually has
  // (`availableResolutions` on a 360x640 upload reads "240p,360p"). Signing
  // `play_1080p.mp4` for it is a 404, which is what made the Download button
  // fail on every video in the library.
  describe("pickAvailableQuality", () => {
    it("serves the requested quality when the video has it", () => {
      expect(pickAvailableQuality("240p,360p,480p,720p", "480p")).toBe("480p");
    });

    it("steps down to the best resolution at or below the request", () => {
      expect(pickAvailableQuality("240p,360p", "1080p")).toBe("360p");
      expect(pickAvailableQuality("480p,720p", "720p")).toBe("720p");
    });

    it("never invents a resolution Bunny did not list", () => {
      expect(pickAvailableQuality("240p,360p,480p", "480p")).toBe("480p");
      expect(pickAvailableQuality("360p", "1080p")).toBe("360p");
    });

    it("ignores values that are not downloadable renditions", () => {
      // 361p and `original` are not renditions; 240p is, and it is the best one
      // on offer here, so it is what gets served.
      expect(pickAvailableQuality("240p, 361p, original", "720p")).toBe("240p");
    });

    // Better to ask for the requested file than to guess: Bunny is silent about
    // a video it has not finished encoding, and that is not a downgrade.
    it("keeps the requested quality when Bunny says nothing", () => {
      expect(pickAvailableQuality(null, "1080p")).toBe("1080p");
      expect(pickAvailableQuality("", "720p")).toBe("720p");
    });
  });

  it("reports configuration completeness", () => {
    expect(isBunnyConfigured()).toBe(true);
    expect(isBunnyPlaybackConfigured()).toBe(true);

    bunny.tokenSecret = "";
    expect(isBunnyConfigured()).toBe(true);
    expect(isBunnyPlaybackConfigured()).toBe(false);
  });

  it("safe variants return null instead of throwing when unconfigured", () => {
    bunny.tokenSecret = "";
    bunny.cdnHostname = "";

    expect(safeTeaserUrl("abc-123")).toBeNull();
    expect(safeSignedVideoUrl("abc-123")).toBeNull();
    expect(safeDownloadUrl("abc-123")).toBeNull();
    // A video with no Bunny id at all is not an error either
    expect(safeTeaserUrl(null)).toBeNull();
    expect(safeSignedVideoUrl(null)).toBeNull();
  });

  it("safe variants return the URL when configured", () => {
    expect(safeTeaserUrl("abc-123")).toContain("/abc-123/playlist.m3u8");
    expect(safeSignedVideoUrl("abc-123")).toContain("token=");
    expect(safeDownloadUrl("abc-123", "480p")).toContain("/abc-123/play_480p.mp4");
  });
});
