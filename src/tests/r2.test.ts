// =============================================================================
// GENHUB - Cloudflare R2 signing
//
// The one part of the background clip's transport that cannot be exercised by
// reading it: a presigned URL is only correct if a specific byte string was
// hashed in a specific order, and getting any of it wrong produces a flat 403
// with nothing in it that says which field was at fault. So what is pinned here:
//
//   * the URL's shape — the query parameters SigV4 requires, sorted, encoded;
//   * that the same inputs always produce the same URL (it is deterministic, and
//     nothing in it depends on the clock except the two timestamps);
//   * that a signed content type is COVERED by the signature, so a client cannot
//     upload with a different one;
//   * that keys a caller could influence cannot address anything outside the
//     clips' own directory;
//   * the public-URL builder, which is the difference between the CDN carrying a
//     clip and every visitor's bytes being proxied through the app.
//
// Config is mocked: these are pure functions of it, and a test must not depend
// on whichever credentials happen to be in a developer's .env.local.
// =============================================================================

import { describe, it, expect, vi } from "vitest";

// `vi.hoisted`, because the mock factory is hoisted above every other binding in
// this file — a plain const here is a ReferenceError, not an override.
const CREDS = vi.hoisted(() => ({
  accountId: "acct123",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "c2VjcmV0LXZhbHVlLWZvci10ZXN0cw==",
  bucket: "genhub-uploads",
  publicBaseUrl: "https://cdn.example.com/",
}));

vi.mock("@/lib/config", () => ({
  default: { r2: CREDS },
}));

import {
  isR2Configured,
  isSafeR2Key,
  presignR2Url,
  r2BackgroundKey,
  r2BackgroundKeyFor,
  r2PublicUrl,
} from "@/lib/r2";

const TOKEN = "0123456789abcdef01234567";
/** A fixed instant: the signature depends on the clock, so the clock is fixed. */
const NOW = new Date("2026-10-10T12:00:00.000Z");

function presign(overrides: Partial<Parameters<typeof presignR2Url>[0]> = {}) {
  return presignR2Url({
    method: "PUT",
    key: r2BackgroundKey(TOKEN, ".mp4"),
    expiresInSeconds: 3600,
    contentType: "video/mp4",
    now: NOW,
    ...overrides,
  });
}

describe("R2 credentials", () => {
  it("is configured when the pair, the account and the bucket are all present", () => {
    expect(isR2Configured()).toBe(true);
  });
});

describe("object keys", () => {
  it("builds the key from the token and an allowlisted extension", () => {
    expect(r2BackgroundKey(TOKEN, ".mp4")).toBe(`site/background/${TOKEN}.mp4`);
  });

  it("refuses a row this app would not have written", () => {
    expect(r2BackgroundKeyFor(TOKEN, "video/mp4")).toBe(`site/background/${TOKEN}.mp4`);
    expect(r2BackgroundKeyFor(TOKEN, "video/x-matroska")).toBe(`site/background/${TOKEN}.mkv`);
    // A token that is not 24 hex, or a media type that is not one we store, has
    // no key — which the serving route answers as "nothing to play".
    expect(r2BackgroundKeyFor("../../etc/passwd", "video/mp4")).toBe(null);
    expect(r2BackgroundKeyFor(TOKEN.toUpperCase(), "video/mp4")).toBe(null);
    expect(r2BackgroundKeyFor(TOKEN, "text/html")).toBe(null);
    expect(r2BackgroundKeyFor(TOKEN, "")).toBe(null);
  });

  it("accepts only keys that stay inside the bucket's own shape", () => {
    expect(isSafeR2Key(`site/background/${TOKEN}.mp4`)).toBe(true);
    expect(isSafeR2Key("")).toBe(false);
    expect(isSafeR2Key("/etc/passwd")).toBe(false);
    expect(isSafeR2Key("site/../secret")).toBe(false);
    expect(isSafeR2Key("site//background")).toBe(false);
    expect(isSafeR2Key("site/background/x.mp4?acl=public")).toBe(false);
    expect(isSafeR2Key("site\\background\\x.mp4")).toBe(false);
    expect(isSafeR2Key("site/background/x.mp4#frag")).toBe(false);
  });
});

describe("presignR2Url", () => {
  it("carries every parameter SigV4 requires, sorted and encoded", () => {
    const { url } = presign();
    const query = url.slice(url.indexOf("?") + 1);

    expect(url.startsWith(`https://acct123.r2.cloudflarestorage.com/genhub-uploads/site/background/${TOKEN}.mp4?`)).toBe(true);
    expect(query).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    // The credential's scope is date/region/service/terminator, and the region is
    // R2's `auto` — a fixed value, not a configurable one.
    expect(query).toContain(
      encodeURIComponent("AKIAEXAMPLE/20261010/auto/s3/aws4_request")
    );
    expect(query).toContain("X-Amz-Date=20261010T120000Z");
    expect(query).toContain("X-Amz-Expires=3600");
    expect(query).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
    // 64 lowercase hex, and the parameter order is irrelevant to the server —
    // it re-sorts for verification, which is why the signature is not last here.
    expect(query).toMatch(/X-Amz-Signature=[0-9a-f]{64}(&|$)/);

    const names = query.split("&").map((pair) => pair.split("=")[0]);
    expect(names).toEqual([...names].sort());
  });

  it("is deterministic for the same inputs", () => {
    expect(presign().url).toBe(presign().url);
  });

  it("expires, and reports when", () => {
    const { expiresAt } = presign({ expiresInSeconds: 600 });
    expect(expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 600);
  });

  // The content type is what R2 stores on the object and what the serving route
  // later sends to every browser, so it has to be part of what was signed.
  it("covers the content type it was given", () => {
    const withType = presign({ contentType: "video/mp4" });
    const withoutType = presign({ contentType: undefined });

    expect(withType.headers).toEqual({ "content-type": "video/mp4" });
    expect(withoutType.headers).toEqual({});
    expect(withType.url).not.toBe(withoutType.url);
    expect(withType.url).toContain("content-type%3Bhost");
    expect(withoutType.url).toContain("X-Amz-SignedHeaders=host");
  });

  it("refuses to sign a key that could address something else", () => {
    expect(() => presign({ key: "../../etc/passwd" })).toThrow();
    expect(() => presign({ key: "site/../other/x.mp4" })).toThrow();
  });
});

describe("r2PublicUrl", () => {
  it("builds the address a visitor can fetch, without doubling the slash", () => {
    expect(r2PublicUrl(`site/background/${TOKEN}.mp4`)).toBe(
      `https://cdn.example.com/site/background/${TOKEN}.mp4`
    );
  });

  // No public hostname is not an error: the serving route falls back to proxying
  // ranges, which is correct and merely more expensive.
  it("answers null for a key it would not write", () => {
    expect(r2PublicUrl("site/../secret")).toBe(null);
    expect(r2PublicUrl("")).toBe(null);
  });
});
