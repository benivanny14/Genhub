// =============================================================================
// GENHUB - Media keys, and the two ways they go wrong
//
// Everything the app stores an image for — a video thumbnail, a profile picture,
// an ID document — comes back through /api/media/<key>. That one route decides
// who can read a file, from the key alone, which makes two mistakes possible and
// both of them serious:
//
//   1. A key that escapes the storage zone. `..` or a leading `/` must never
//      reach the outbound request, or a URL parameter becomes a request for an
//      arbitrary object in the Bunny account.
//
//   2. An identity document served as if it were a thumbnail. `private/<userId>/`
//      must be recognised as private — and the pre-fix `uploads/` layout, which
//      is where KYC photos actually were, must not be silently made public by a
//      rewrite either.
//
// The URL healing is pinned too, because it is what makes the existing rows point
// somewhere that works: the old value is `https://<stream zone>/<key>`, and only
// the key is meaningful — the host is the part that was wrong.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  MEDIA_ROUTE_PREFIX,
  cacheControlFor,
  contentTypeForKey,
  isMediaPrivate,
  isSafeMediaKey,
  mediaKeyFromUrl,
  mediaKindOf,
  mediaUrlFor,
  normalizeMediaUrl,
  ownerOfPrivateKey,
} from "@/lib/media";

const CDN = "vz-adb8d04b-1b4.b-cdn.net";

describe("isSafeMediaKey", () => {
  it("accepts the keys we generate", () => {
    expect(isSafeMediaKey("uploads/2026-09/56bd09af5f4808ccebd2.jpg")).toBe(true);
    expect(isSafeMediaKey("public/images/2026-09/abc.png")).toBe(true);
    expect(isSafeMediaKey("private/user_1/2026-09/abc.webp")).toBe(true);
  });

  it("refuses anything that could climb out of the zone", () => {
    expect(isSafeMediaKey("../../../etc/passwd")).toBe(false);
    expect(isSafeMediaKey("uploads/../../secret")).toBe(false);
    expect(isSafeMediaKey("/etc/passwd")).toBe(false);
    expect(isSafeMediaKey("uploads\\..\\secret")).toBe(false);
    expect(isSafeMediaKey("uploads//double.jpg")).toBe(false);
    expect(isSafeMediaKey("uploads/./file.jpg")).toBe(false);
  });

  it("refuses an empty key, a trailing slash and a query string", () => {
    expect(isSafeMediaKey("")).toBe(false);
    expect(isSafeMediaKey("uploads/")).toBe(false);
    expect(isSafeMediaKey("uploads/a.jpg?x=1")).toBe(false);
  });

  it("refuses control characters and anything outside the generated alphabet", () => {
    expect(isSafeMediaKey("uploads/a\nb.jpg")).toBe(false);
    expect(isSafeMediaKey("uploads/a b.jpg")).toBe(false);
    expect(isSafeMediaKey("uploads/a<b>.jpg")).toBe(false);
    expect(isSafeMediaKey("uploads/naïve.jpg")).toBe(false);
  });

  it("refuses a key long enough to be a payload rather than a name", () => {
    expect(isSafeMediaKey(`uploads/${"a".repeat(600)}.jpg`)).toBe(false);
  });
});

describe("mediaKindOf / ownerOfPrivateKey", () => {
  it("reads the kind from the first segment", () => {
    expect(mediaKindOf("private/u1/2026-09/a.jpg")).toBe("private");
    expect(mediaKindOf("public/images/2026-09/a.jpg")).toBe("public");
    expect(mediaKindOf("uploads/2026-09/a.jpg")).toBe("public");
  });

  it("knows who owns a private key, and says nothing for a public one", () => {
    expect(ownerOfPrivateKey("private/u1/2026-09/a.jpg")).toBe("u1");
    expect(ownerOfPrivateKey("public/images/2026-09/a.jpg")).toBeNull();
  });

  it("returns no owner for a malformed private key rather than an empty id", () => {
    // "" is falsy, so a truncated key can never be read as "owned by nobody" and
    // slip past the proxy's `owner != null` check.
    expect(ownerOfPrivateKey("private/")).toBeNull();
  });
});

describe("mediaKeyFromUrl", () => {
  it("recovers the key from our own route", () => {
    expect(mediaKeyFromUrl("/api/media/uploads/2026-09/a.jpg")).toBe("uploads/2026-09/a.jpg");
    expect(mediaKeyFromUrl("/api/media/private/u1/kyc/a.jpg")).toBe("private/u1/kyc/a.jpg");
  });

  it("recovers the key from a full Bunny CDN URL — including the wrong host", () => {
    // The pre-fix rows point at the STREAM pull zone. The host is the bug; the
    // key is the part that is still right.
    expect(mediaKeyFromUrl(`https://${CDN}/uploads/2026-09/a.jpg`, CDN)).toBe(
      "uploads/2026-09/a.jpg"
    );
    expect(
      mediaKeyFromUrl("https://genhub-thumbs.b-cdn.net/uploads/2026-09/a.jpg", CDN)
    ).toBe("uploads/2026-09/a.jpg");
  });

  it("recovers the local dev layout", () => {
    expect(mediaKeyFromUrl("/uploads/2026-09/a.jpg")).toBe("uploads/2026-09/a.jpg");
  });

  it("leaves a third-party URL alone — it is not reclaimable as ours", () => {
    expect(mediaKeyFromUrl("https://evil.example/uploads/a.jpg", CDN)).toBeNull();
    expect(mediaKeyFromUrl("https://drive.google.com/file/d/abc.jpg", CDN)).toBeNull();
    expect(mediaKeyFromUrl("https://cdn.example.com/a.b-cdn.net.evil.com/a.jpg", CDN)).toBeNull();
  });

  it("refuses a traversal hidden inside a URL", () => {
    // Encoded traversal survives the URL parser and reaches the key check, which
    // rejects it outright.
    expect(mediaKeyFromUrl("/api/media/../../secret")).toBeNull();
    expect(mediaKeyFromUrl("/api/media/%2e%2e%2f%2e%2e%2fsecret")).toBeNull();
    // A raw traversal in a full URL is collapsed by the URL parser before we see
    // it, so what comes out is an ordinary in-zone key. Pin the property that
    // matters rather than the shape: no `..` ever survives into a key, so the
    // outbound request can only ever address an object inside the zone.
    const collapsed = mediaKeyFromUrl(`https://${CDN}/uploads/../../secret`, CDN);
    expect(collapsed).not.toContain("..");
    expect(collapsed).toBe("secret");
  });

  it("returns null for nothing at all", () => {
    expect(mediaKeyFromUrl(null)).toBeNull();
    expect(mediaKeyFromUrl(undefined)).toBeNull();
    expect(mediaKeyFromUrl("   ")).toBeNull();
    expect(mediaKeyFromUrl("uploads/2026-09/a.jpg")).toBeNull();
  });
});

describe("normalizeMediaUrl", () => {
  it("rewrites a legacy CDN URL to the route that serves it", () => {
    expect(normalizeMediaUrl(`https://${CDN}/uploads/2026-09/a.jpg`, CDN)).toBe(
      "/api/media/uploads/2026-09/a.jpg"
    );
  });

  it("is idempotent", () => {
    const once = normalizeMediaUrl(`https://${CDN}/uploads/a.jpg`, CDN);
    expect(normalizeMediaUrl(once, CDN)).toBe(once);
  });

  it("keeps an external URL as it is", () => {
    expect(normalizeMediaUrl("https://example.com/a.jpg", CDN)).toBe("https://example.com/a.jpg");
  });

  it("trims, and turns nothing into null", () => {
    expect(normalizeMediaUrl("  ", CDN)).toBeNull();
    expect(normalizeMediaUrl(null, CDN)).toBeNull();
    expect(normalizeMediaUrl(`  https://${CDN}/uploads/a.jpg  `, CDN)).toBe(
      "/api/media/uploads/a.jpg"
    );
  });
});

describe("serving rules", () => {
  it("builds the in-app URL", () => {
    expect(mediaUrlFor("public/images/a.jpg")).toBe("/api/media/public/images/a.jpg");
    expect(MEDIA_ROUTE_PREFIX).toBe("/api/media/");
  });

  it("names a content type from the extension", () => {
    expect(contentTypeForKey("uploads/a.jpg")).toBe("image/jpeg");
    expect(contentTypeForKey("uploads/a.PNG")).toBe("image/png");
    expect(contentTypeForKey("uploads/a.webp")).toBe("image/webp");
    expect(contentTypeForKey("uploads/a.heic")).toBe("image/heic");
    expect(contentTypeForKey("uploads/a.bin")).toBe("application/octet-stream");
  });

  it("makes a private key uncacheable and a public one immutable", () => {
    expect(cacheControlFor("private/u1/kyc/id.png")).toContain("no-store");
    expect(cacheControlFor("public/images/a.jpg")).toContain("immutable");
    expect(cacheControlFor("uploads/a.jpg")).toContain("immutable");
  });

  it("reports privacy from the key alone", () => {
    expect(isMediaPrivate("private/u1/kyc/id.png")).toBe(true);
    expect(isMediaPrivate("public/images/a.jpg")).toBe(false);
    // The pre-fix layout is NOT private by path. The proxy additionally checks
    // the KYC rows for these keys, because that is where identity documents
    // actually ended up — see the route's kycOwnerOfLegacyKey.
    expect(isMediaPrivate("uploads/a.jpg")).toBe(false);
  });
});
