// =============================================================================
// GENHUB - Where uploaded images live, and who may read them
// =============================================================================
//
// Two Bunny products are involved and they are NOT interchangeable:
//
//   Bunny Stream   library 760553  ->  vz-...b-cdn.net/{videoGuid}/playlist.m3u8
//   Bunny Storage  genhub-thumbs   ->  served through /api/media/... (see below)
//
// Thumbnails, avatars, KYC photos are all files in the STORAGE zone. They used
// to be handed to the browser as `https://${BUNNY_CDN_HOSTNAME}/${key}` — i.e.
// through the STREAM pull zone, which serves the video library and nothing else.
// Every one of them answered 403 (verified against production: both the
// `vz-...` host and `genhub-thumbs.b-cdn.net`, whose zone reports "Domain
// suspended or not configured"). That is why no thumbnail, no avatar and no KYC
// photo ever appeared in the UI.
//
// The storage zone has no working pull zone at all, and creating one is a Bunny
// dashboard change. So the app serves its own images: /api/media/<key> reads the
// object from the storage zone with the access key and streams it back. No new
// credentials, no dashboard step, and it works today.
//
// A key is a storage path, and its FIRST SEGMENT decides who may read it:
//
//   public/...          anyone. Feed covers, avatars, video thumbnails.
//   private/<userId>/   that user, or an admin. KYC documents.
//   uploads/...         the pre-fix layout. Public for images, but a key that a
//                       KYC row still points at is treated as private until the
//                       migration moves it (see scripts/normalize-media-urls.mjs).
//
// Keeping the rule in one pure module means the upload route, the proxy and the
// migration cannot disagree about what a key means — the failure mode of getting
// that wrong is publishing somebody's ID document.

/** Every generated image URL starts here. */
export const MEDIA_ROUTE_PREFIX = "/api/media/";

export type MediaKind = "public" | "private";

/** Bunny's storage origin. Not a CDN — it needs the AccessKey header. */
export const BUNNY_STORAGE_ORIGIN = "https://storage.bunnycdn.com";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  avif: "image/avif",
};

/**
 * Is this a storage key we are willing to build a Bunny request out of?
 *
 * This is the only guard between a URL segment and an outbound request, so it is
 * deliberately strict: no empty segments, no `..`, no leading `/`, no backslash,
 * no control characters, and only the characters a generated filename uses. A
 * key that passes can still only address objects inside the zone, because the
 * origin is fixed and the key cannot become a host or a scheme.
 */
export function isSafeMediaKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("\\") || key.includes("?")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  const segments = key.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The first path segment: what the key is for. */
export function mediaKindOf(key: string): MediaKind {
  return key.split("/")[0] === "private" ? "private" : "public";
}

/**
 * The user a private key belongs to, or null.
 * `private/<userId>/<stamp>/<name>` — the id is part of the path on purpose: it
 * is what the proxy checks against the session, so an owner check can never be
 * skipped by a missing database row.
 */
export function ownerOfPrivateKey(key: string): string | null {
  if (mediaKindOf(key) !== "private") return null;
  const owner = key.split("/")[1];
  return owner || null;
}

/** The in-app URL a browser should use for a storage key. */
export function mediaUrlFor(key: string): string {
  return `${MEDIA_ROUTE_PREFIX}${key}`;
}

/**
 * Recover the storage key from a URL we (or the pre-fix code) produced.
 *
 * Accepts the three shapes that exist in the wild:
 *   /api/media/<key>                     this app, current layout
 *   /uploads/<key>                       this app, local-disk layout (dev)
 *   https://<any host>/<key>             a full Bunny CDN URL
 *
 * The last one is the reason this function takes a hostname: the pre-fix URLs
 * point at BOTH the stream pull zone and the storage zone, and only the key is
 * meaningful — the host is exactly the part that was wrong. A URL on some other
 * host (a creator pasting a Google Drive link, a demo row pointing at a test
 * stream) is NOT reclaimed: it is left alone and returned as null.
 */
export function mediaKeyFromUrl(
  value: string | null | undefined,
  bunnyHostname?: string
): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith(MEDIA_ROUTE_PREFIX)) {
    const key = decodeURIComponent(raw.slice(MEDIA_ROUTE_PREFIX.length));
    return isSafeMediaKey(key) ? key : null;
  }

  if (raw.startsWith("/uploads/")) {
    const key = decodeURIComponent(raw.slice(1));
    return isSafeMediaKey(key) ? key : null;
  }

  if (!bunnyHostname) return null;
  if (!/^https?:\/\//i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Bunny serves the zone's objects from a handful of hostnames (the zone's own
  // b-cdn.net name and any custom hostname). Rather than guess which, accept any
  // *.b-cdn.net host plus the configured one: a b-cdn.net URL can only ever be
  // a Bunny object, so no third-party URL is ever reclaimed as ours.
  const isBunny = url.hostname === bunnyHostname || url.hostname.endsWith(".b-cdn.net");
  if (!isBunny) return null;

  const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return isSafeMediaKey(key) ? key : null;
}

/**
 * The URL to store for a value a creator or an admin typed/pasted.
 *
 * Returns the normalised in-app URL when the value is one of ours (so a legacy
 * CDN URL is healed on write, not just on read), the trimmed original otherwise
 * (a plain external https URL is still allowed — demo rows use them), and null
 * when there is nothing usable.
 */
export function normalizeMediaUrl(
  value: string | null | undefined,
  bunnyHostname?: string
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = mediaKeyFromUrl(trimmed, bunnyHostname);
  return key ? mediaUrlFor(key) : trimmed;
}

/** Pick a Content-Type from the key's extension. */
export function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

/**
 * Cache header for a media response.
 *
 * Public keys are content-addressed (a random 20-hex name per upload), so they
 * can be cached for a year — re-uploading a thumbnail makes a new key, never a
 * new body under the same one. Private keys must never be cached, by us or by
 * any proxy in between: the bytes are somebody's identity document.
 */
export function cacheControlFor(key: string): string {
  return mediaKindOf(key) === "private"
    ? "private, no-store, max-age=0"
    : "public, max-age=31536000, immutable";
}

/** Should this response be visible to a shared cache / search engine? */
export function isMediaPrivate(key: string): boolean {
  return mediaKindOf(key) === "private";
}
