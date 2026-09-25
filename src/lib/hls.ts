// =============================================================================
// GENHUB - HLS manifest rewriting
// =============================================================================
// Why this file exists, in one paragraph.
//
// Bunny's pull zone is behind Token Authentication, and the ONLY authorisation
// it accepts is a query string (`?token=…&expires=…`) — the `bcdn_token` path
// form this repo used to emit is refused with 403 even when the signature is
// correct (see lib/bunny.ts for the measurement). A query string cannot survive
// HLS, though: a player resolves the relative URLs inside a manifest against the
// manifest's own URL, and URL resolution DROPS the query string. So the manifest
// loads, and then every rendition and every segment comes back 403 — a player
// that shows a poster, a spinner, and never plays.
//
// The fix is to stop handing the player a CDN manifest and hand it one of ours:
// the stream route fetches the manifest with an authorised request and rewrites
// every URI inside it so that it carries its own authorisation. Bunny signs a
// FOLDER and honours the signature for everything under it (verified against the
// live zone), so the same `&token=…&expires=…` authorises the manifest, both
// renditions and every segment.
//
// Nested playlists point back at our own route, which is what keeps the secret
// server-side: the browser is given expiring CDN URLs for media, never a way to
// mint one. Segments are fetched straight from the CDN (it answers
// Access-Control-Allow-Origin: *), so this costs one small request per level and
// no video bandwidth through the app.
//
// The rewriting itself is pure string work so it can be tested without a
// network — tests/hls.test.ts covers the shapes Bunny actually emits.
// =============================================================================

export interface HlsRewriteOptions {
  /** Pull-zone host that serves the video, e.g. `vz-abc123.b-cdn.net`. */
  cdnHostname: string;
  /** Bunny GUID of the video — the folder the token authorises. */
  bunnyVideoId: string;
  /** `token=…&expires=…`, signed for `/<bunnyVideoId>/`. */
  cdnQuery: string;
  /** Our own stream route, e.g. `/api/videos/row-id/stream` or `…?source=teaser`. */
  proxyHref: string;
  /**
   * Folder the manifest being rewritten lives in, relative to the video folder —
   * `""` for the master playlist, `"360p/"` for a rendition.
   */
  directory?: string;
}

const PLAYLIST = /\.m3u8(\?|#|$)/i;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Collapse `.` and `..` so a rewritten URL is exactly the path Bunny gets. */
function normalize(uri: string): string {
  const parts: string[] = [];
  for (const segment of uri.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/**
 * A child URI, expressed as a path inside the video's folder.
 *
 * Manifests are usually relative (`video0.ts` next to its playlist, `240p/…`
 * from the master), but a root-relative `/guid/240p/video0.ts` is legal and
 * Bunny has been seen to emit absolute same-zone URLs. All three collapse to the
 * same thing once the origin and the video folder are stripped.
 */
function toVideoRelative(uri: string, directory: string, options: HlsRewriteOptions): string {
  const prefix = `https://${options.cdnHostname}/`;
  if (uri.startsWith(prefix)) {
    uri = uri.slice(prefix.length);
  }
  if (uri.startsWith("/")) {
    uri = uri.replace(/^\/+/, "");
  } else if (!ABSOLUTE.test(uri)) {
    uri = `${directory}${uri}`;
  }
  const folder = `${options.bunnyVideoId}/`;
  if (uri.startsWith(folder)) uri = uri.slice(folder.length);
  return normalize(uri);
}

/** Our own route for a nested playlist, so it too comes back rewritten. */
function proxyUrlFor(relative: string, proxyHref: string): string {
  const [base, existing] = proxyHref.split("?", 2);
  const query = [`path=${encodeURIComponent(relative)}`];
  if (existing) query.push(existing);
  return `${base}?${query.join("&")}`;
}

/** The authorised CDN URL for one child (segment, key file, MP4 rendition). */
function cdnUrlFor(relative: string, options: HlsRewriteOptions): string {
  return `https://${options.cdnHostname}/${options.bunnyVideoId}/${relative}?${options.cdnQuery}`;
}

function rewriteUri(uri: string, options: HlsRewriteOptions): string {
  // Another host entirely: not ours to authorise, and not something this
  // function should touch.
  if (ABSOLUTE.test(uri) && !uri.includes(`${options.cdnHostname}/`)) return uri;
  // Already authorised (a manifest that was rewritten once, or a Bunny-emitted
  // signed URL): re-signing would only risk a double query string.
  if (/[?&](bcdn_)?token=/i.test(uri)) return uri;

  const relative = toVideoRelative(uri, options.directory ?? "", options);
  if (!relative) return uri;

  return PLAYLIST.test(uri)
    ? proxyUrlFor(relative, options.proxyHref)
    : cdnUrlFor(relative, options);
}

/**
 * Rewrite one HLS manifest so every URI in it is authorised.
 *
 * Handles all four places a URI can hide: a bare line (a variant playlist or a
 * segment), and the `URI="…"` attribute of the tags that carry one — encryption
 * keys (`EXT-X-KEY`, `EXT-X-SESSION-KEY`), initialisation maps (`EXT-X-MAP`),
 * alternate renditions (`EXT-X-MEDIA`) and I-frame playlists
 * (`EXT-X-I-FRAME-STREAM-INF`). Anything else is passed through byte for byte,
 * comments included, because a manifest is a document the player parses and
 * mangling it is worse than not touching it.
 */
export function rewriteHlsManifest(body: string, options: HlsRewriteOptions): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;

      if (line.startsWith("#")) {
        // Rewrite the URI attribute wherever the tag carries one, and leave the
        // rest of the tag (`#EXT-X-KEY:METHOD=AES-128,…`) untouched.
        return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${rewriteUri(uri, options)}"`);
      }

      return rewriteUri(line.trim(), options);
    })
    .join("\n");
}
