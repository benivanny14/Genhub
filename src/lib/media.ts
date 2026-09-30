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

import { isHeifExtension } from "./image-bytes";

/** Every generated image URL starts here. */
/**
 * What a video file input should offer: MIME types AND extensions.
 *
 * `video/*` on its own is not enough on Android, and the consequence is a
 * creator reporting that their video "is not there". The system picker filters
 * by the types it is handed, and it decides per provider: a file whose provider
 * reports no MIME type — an .mkv off an SD card, a .mov from a camera app, a
 * download from a chat app — is hidden or greyed out by the MIME filter alone.
 * The extensions are the same allowance written the other way round, so the
 * picker offers the file whichever way it chooses to filter.
 *
 * One constant because three inputs ask the question (the main video, the
 * trailer on the upload page, the trailer in the editor), and three copies of a
 * list is how one of them ends up accepting less than the others — which is
 * exactly the "only works from Downloads" report this was written for.
 */
/**
 * The extensions that mean "video", and the ones that mean "image".
 *
 * The lists above and the classifier below are the same knowledge written twice
 * — once for a picker, which decides what to OFFER, and once for the code, which
 * decides what was CHOSEN. They have to agree, and on Android they are each
 * other's safety net: the picker filters by MIME, and the MIME is exactly what a
 * document provider is worst at. One list, so a format cannot be accepted by one
 * half and refused by the other.
 */
export const VIDEO_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "3gp",
  "3g2",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "flv",
  "mts",
  "m2ts",
  "mpg",
  "mpeg",
  "ts",
] as const;

/**
 * Every picture format this app will take as a cover, an avatar or a KYC photo.
 *
 * Deliberately wide, and wider than it was. The rule used to be "the formats we
 * are sure we can handle", which is a rule about US, applied to a creator's
 * picture: a HEIC off an Android gallery, an AVIF saved by a browser, a BMP
 * exported by an old editor — each was refused by name, and the creator was
 * told to choose an image while looking at the image they had chosen.
 *
 * What a format has to earn is narrower now: it has to BE a picture. What
 * happens to it afterwards is a separate question with a separate answer — the
 * browser re-encodes what it can decode (lib/image-downscale), and what it
 * cannot is still accepted as-is, with the framing step skipped rather than the
 * file refused.
 *
 * SVG is the one deliberate absence, and it is not a picture in this sense: it
 * is a document that can carry script, and this app serves its uploads from its
 * own origin.
 */
export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "avif",
  "bmp",
  "tif",
  "tiff",
  "gif",
  "heic",
  "heif",
] as const;

const extensionsOf = (list: readonly string[]) => list.map((ext) => `.${ext}`).join(",");

export const VIDEO_ACCEPT = `video/*,${extensionsOf(VIDEO_EXTENSIONS)}`;

/**
 * The same, for a picture. For the rare caller that can afford a filter —
 * every picker a creator meets in the studio is untyped instead.
 */
export const IMAGE_ACCEPT = `image/*,${extensionsOf(IMAGE_EXTENSIONS)}`;

/**
 * A picker that hides NOTHING.
 *
 * Every filter above is a promise about a file that the picker has to decide
 * before anyone has read it, and on a phone that promise is kept by the system
 * document provider — which answers from an index, not from the disk. A video a
 * chat app saved into its own folder, a recording on a card the media scanner
 * never walked, a file sitting in the cloud: all of them are absent or greyed
 * out under a type filter, and NONE of that is visible from here. The creator
 * sees a picker with their video missing and concludes the app cannot do it.
 *
 * So this is the second door, and it is deliberately untyped: asking for every
 * type asks for every provider and every folder, which is the only thing a web
 * page can request that cannot hide a file. What the file IS gets decided
 * afterwards, by reading it — which is the only place that question has an
 * honest answer anyway.
 */
export const ANY_FILE_ACCEPT = "*/*";

export type FileKind = "video" | "image" | "other";

/** The lower-case extension of a name, or "" when it has none. */
function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * What did the creator just choose?
 *
 * This exists because a picker that hides nothing cannot promise anything: the
 * untyped input that gets past Android's file index hands back whatever was
 * tapped, so the type has to be READ rather than assumed. Two signals, and the
 * order they are trusted in is the whole point:
 *
 *   1. A MIME the browser is sure about (`video/…`, `image/…`) wins. When it is
 *      there, it is right.
 *   2. Otherwise the EXTENSION decides — and on Android that is the common case,
 *      not the edge one. A chat app's download, a card's recording, anything the
 *      document provider has not indexed arrives as `""`, as
 *      `application/octet-stream`, or as a MIME from a completely different
 *      family. Trusting the MIME first here would reject real videos by the
 *      hundred, which is the fault this whole change is about.
 *
 * A name with neither — an untyped file with no extension — is `"other"`, which
 * the caller refuses out loud rather than sending to Bunny to fail encoding.
 */
export function classifyFile(file: { name?: string | null; type?: string | null }): FileKind {
  const mime = (file.type || "").trim().toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";

  const ext = extensionOf(file.name || "");
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  return "other";
}

/**
 * Does this name look like a copy Google Photos or Drive handed to a file
 * manager? `1000369346.mp4` — ten digits, then an ordinary extension.
 *
 * It is a HEURISTIC and only ever used to warn: the measured case is a live
 * creator whose 192 MB video the phone would not read on two different networks,
 * and files named exactly like this are the shape those downloads take. A false
 * positive costs one sentence of advice; a false negative costs what it cost
 * them — a file that cannot be read, discovered after the attempt.
 */
export function isLikelyCloudCopy(name: string | null | undefined): boolean {
  return /^\d{8,}\.(mp4|mov|jpg|jpeg|png)$/i.test((name || "").trim());
}

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
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  // Captions. The media proxy serves whatever Content-Type the key implies, and
  // a browser refuses to parse a <track> whose response is
  // application/octet-stream — the captions would simply never appear, with no
  // error anywhere. This entry is what makes an uploaded .vtt playable.
  vtt: "text/vtt",
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
 * May this URL be handed to next/image's optimiser?
 *
 * Two kinds of source must NOT be, and both fail by showing nothing at all:
 *
 *   * a host that is not listed in next.config.js `images.remotePatterns` — a
 *     creator who pasted an image URL, a legacy external avatar. The optimiser
 *     answers 400 and the picture silently disappears;
 *   * ANY key the media route gates behind a session — `private/…` (KYC
 *     documents) and the legacy `uploads/…` keys a KYC row still points at. The
 *     optimiser fetches from our own media route WITHOUT cookies, so the route
 *     answers 401 and the picture renders broken.
 *
 * So the rule is the narrow one: a key under `public/` was put there by the
 * upload route and is readable by anyone. Those — the common case, an avatar or
 * a thumbnail — go through the optimiser, and that is where the bytes are saved:
 * a 512×512 upload rendered at 32px costs a phone on mobile data sixteen times
 * what it should. Everything else is used as-is.
 */
export function canOptimizeImage(src: string | null | undefined): boolean {
  if (!src) return false;
  if (!src.startsWith(`${MEDIA_ROUTE_PREFIX}public/`)) return false;
  // Third kind that must not be: a HEIF container (AVIF, HEIC). Next 14 decodes
  // those with sharp/libheif, which has a critical unauthenticated RCE on the
  // AVIF path (GHSA-2xp9-vwfh-vxw4); the patched releases fix it by refusing to
  // optimise AVIF at all, and Next 14 has no equivalent switch. The upload route
  // already refuses a HEIF file wearing a non-HEIF name, so what reaches here is
  // an honest HEIC/HEIF photo — which the browser is handed as-is. Safari
  // displays it, other browsers do not, and that was already true.
  return !isHeifExtension(src);
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
