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
  BunnyNotConfiguredError,
} from "@/lib/bunny";

const expectedToken = (path: string, expires: number, secret: string) =>
  createHmac("sha256", secret)
    .update(`${expires}${path}`)
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
  /** Pull the token parameters out of the path-based URL form. */
  function readDirectoryToken(url: URL, videoId: string) {
    const match = url.pathname.match(
      /^\/bcdn_token=([^&]+)&expires=(\d+)&token_path=([^/]+)(\/.*)$/
    );
    if (!match) throw new Error(`not a path-based token URL: ${url.pathname}`);
    return {
      token: match[1],
      expires: Number(match[2]),
      tokenPath: decodeURIComponent(match[3]),
      path: match[4],
      directory: `/${videoId}/`,
    };
  }

  it("signs the video's whole folder, and puts the token in the PATH", () => {
    const url = new URL(generateSignedVideoUrl("abc-123", 10, "viewer-9"));
    const signed = readDirectoryToken(url, "abc-123");

    expect(url.hostname).toBe("genhub-test.b-cdn.net");
    // The token authorises the folder, not one file: the manifest and every
    // segment it names are separate requests that each have to pass.
    expect(signed.tokenPath).toBe("/abc-123/");
    expect(signed.token).toBe(
      expectedToken("/abc-123/", signed.expires, "test-token-secret")
    );
    // ...and it lives in the path, because an HLS player resolves relative
    // segment URLs against the manifest and URL resolution drops the query
    // string — a `?token=` would authorise the manifest and nothing after it.
    expect(signed.path).toBe("/abc-123/playlist.m3u8");
    expect(url.search).toBe("");
  });

  it("expires roughly `expirationMinutes` from now", () => {
    const before = Math.floor(Date.now() / 1000);
    const url = new URL(generateSignedVideoUrl("abc-123", 10));
    const expires = Number(readDirectoryToken(url, "abc-123").expires);
    expect(expires).toBeGreaterThanOrEqual(before + 10 * 60);
    expect(expires).toBeLessThanOrEqual(before + 10 * 60 + 2);
  });

  it("signs each download rendition with the same folder token", () => {
    const url = new URL(generateDownloadUrl("abc-123", "720p", 10));
    const signed = readDirectoryToken(url, "abc-123");
    expect(signed.path).toBe("/abc-123/play_720p.mp4");
    expect(signed.token).toBe(
      expectedToken("/abc-123/", signed.expires, "test-token-secret")
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
