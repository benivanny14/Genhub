// =============================================================================
// GENHUB - The intro clip: a trailer assembled from the scene itself
// =============================================================================
// Why this file exists.
//
// The intro for a paid scene used to be Bunny's own `preview.webp`: a silent,
// 320x180 animation that Bunny generates from a handful of frames. It fills the
// box, but it is not a trailer — it is a slideshow. What sells a scene is four
// short pieces of MOTION spread across it: the opening, the middle, a little
// further in, and the end.
//
// Bunny already cuts every video into ~4 second HLS segments (measured against
// the live library: sixteen `video0.ts … video15.ts` at 4.000000s each), which is
// exactly the length wanted here. So no transcoding is needed and none is done:
// the clip is four segments chosen from the scene's own playlist, stitched into a
// new manifest that the server generates per viewer
// (route: /api/videos/[id]/intro-clip).
//
// SAFETY IS THE PART TO READ CAREFULLY. The clip is handed to people who have NOT
// paid, so the manifest must not become a way to watch the scene:
//
//   1. The plan is computed here, on the server, from the scene's own playlist.
//      The client never names a segment, a rendition or a path — the route takes
//      no parameters at all — so there is no input it could widen.
//   2. Every URL in the manifest is signed FOR THAT ONE FILE. Measured against
//      the live pull zone: a token signed for `…/360p/video0.ts` answers 403 for
//      `video7.ts`, for the manifests, for `play_360p.mp4` and for another
//      video's segments, and a forged token answers 403 everywhere. So the most
//      a viewer can obtain is the ~16 seconds named in the manifest.
//   3. The clip never covers the whole scene (see planClipSegments): one segment
//      always stays out, and it never exceeds half the running time.
//
// Everything in this file is pure string and number work so the shapes Bunny
// actually emits can be asserted in tests/intro-clip.test.ts without a network.
// =============================================================================

/** Length of each sampled piece. Bunny's own segments are 4.000s, so one segment
 *  is usually exactly one window. */
export const INTRO_CLIP_WINDOW_SECONDS = 4;

/** How many pieces a clip asks for: opening, middle, further in, and the end. */
export const INTRO_CLIP_WINDOWS = 4;

// -----------------------------------------------------------------------------
// Master playlist
// -----------------------------------------------------------------------------

export interface HlsVariant {
  /** Path as written in the manifest, e.g. `360p/video.m3u8`. */
  uri: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
}

/** Read a `NAME=value` or `NAME="value"` attribute out of one tag line. */
function attributeOf(line: string, name: string): string | null {
  const match = line.match(new RegExp(`${name}=("[^"]*"|[^,]*)`, "i"));
  if (!match) return null;
  return match[1].replace(/"/g, "").trim() || null;
}

/**
 * Every `#EXT-X-STREAM-INF` in a master playlist, with the URI that follows it.
 *
 * The URI is the next line that is neither blank nor a comment — a tag between
 * the STREAM-INF and its URI is legal, and Bunny puts a blank line there.
 */
export function parseMasterVariants(body: string): HlsVariant[] {
  const lines = body.split(/\r?\n/);
  const variants: HlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const bandwidth = Number(attributeOf(line, "BANDWIDTH"));
    const resolution = attributeOf(line, "RESOLUTION");
    let width: number | null = null;
    let height: number | null = null;
    if (resolution) {
      const [w, h] = resolution.toLowerCase().split("x").map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) {
        width = w;
        height = h;
      }
    }

    let uri: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (next.startsWith("#")) break;
      uri = next;
      break;
    }
    if (!uri) continue;

    variants.push({
      uri,
      bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : Number.MAX_SAFE_INTEGER,
      width,
      height,
    });
  }

  return variants;
}

/**
 * Which rendition the clip is cut from.
 *
 * The smallest one whose SHORT side is at least 360px. A trailer is watched in a
 * card on a phone, not full screen, so the big renditions only cost the viewer
 * data — and portrait uploads report their real orientation
 * (`RESOLUTION=360x640`), which is why the short side, not `height`, is what
 * "360p" means here. When nothing reaches 360 the best available wins, because a
 * low-resolution trailer still beats no trailer.
 */
export function pickClipVariant(variants: HlsVariant[]): HlsVariant | null {
  if (variants.length === 0) return null;

  const shortSide = (variant: HlsVariant) =>
    variant.width && variant.height
      ? Math.min(variant.width, variant.height)
      : variant.height ?? variant.width ?? 0;

  const byBandwidth = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
  const atLeast360 = byBandwidth.filter((variant) => shortSide(variant) >= 360);
  if (atLeast360.length > 0) return atLeast360[0];

  return [...variants].sort((a, b) => shortSide(b) - shortSide(a))[0];
}

// -----------------------------------------------------------------------------
// Media playlist
// -----------------------------------------------------------------------------

export interface HlsKey {
  method: string;
  uri: string | null;
  iv: string | null;
}

export interface HlsSegment {
  /** Path as written in the manifest, e.g. `video3.ts`. */
  uri: string;
  duration: number;
  /** The `#EXT-X-MAP` in force for this segment (fMP4 renditions only). */
  mapUri: string | null;
  /** The `#EXT-X-KEY` in force for this segment, when the rendition is encrypted. */
  key: HlsKey | null;
}

export interface ParsedMediaPlaylist {
  segments: HlsSegment[];
  version: number;
  targetDuration: number;
}

/**
 * Segments in order, each carrying the key and init map that apply to it.
 *
 * Both are per-segment rather than one-per-playlist because both may change
 * mid-list (a key rotation, a format change). Carrying them along is what makes
 * the stitched manifest correct instead of merely plausible.
 */
export function parseMediaPlaylist(body: string): ParsedMediaPlaylist {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const segments: HlsSegment[] = [];
  let pendingDuration: number | null = null;
  let mapUri: string | null = null;
  let key: HlsKey | null = null;
  let version = 3;
  let targetDuration = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      mapUri = attributeOf(line, "URI");
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const method = attributeOf(line, "METHOD") || "";
      // `METHOD=NONE` is how a playlist says "the encryption stops here".
      key = method.toUpperCase() === "NONE" || !method
        ? null
        : { method, uri: attributeOf(line, "URI"), iv: attributeOf(line, "IV") };
      continue;
    }
    if (line.startsWith("#EXT-X-VERSION:")) {
      const value = Number(line.slice("#EXT-X-VERSION:".length));
      if (Number.isFinite(value) && value > 0) version = value;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const value = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      if (Number.isFinite(value) && value > 0) targetDuration = value;
      continue;
    }
    if (line.startsWith("#")) continue;

    // A URI line. Without a pending duration it belongs to something else (an
    // I-frame playlist), and inventing a duration for it would corrupt the plan.
    if (pendingDuration === null) continue;
    segments.push({ uri: line, duration: pendingDuration, mapUri, key });
    pendingDuration = null;
  }

  return { segments, version, targetDuration };
}

// -----------------------------------------------------------------------------
// Which segments the clip is made of
// -----------------------------------------------------------------------------

export interface ClipPlan {
  /** Indices into the media playlist, ascending and distinct. */
  indices: number[];
  /** Playing time of the clip in seconds. */
  duration: number;
  /** The scene's own running time, straight from the segments. */
  sourceDuration: number;
}

/**
 * The windows the intro is cut from: opening, middle, further in, and the end.
 *
 * Two limits keep this a trailer rather than a copy of the scene:
 *
 *   - one segment always stays out (`segments.length - 1`), and
 *   - the clip never covers more than half the running time.
 *
 * The second is why a 30 second upload gets three windows instead of four: four
 * four-second pieces would be more than half of it, and at that point the intro
 * has given the product away.
 *
 * Targets are spread evenly across the span the window can START in
 * (`0 … duration - windowSeconds`), so the last window ends at the end of the
 * scene and the first one starts at its beginning.
 */
export function planClipSegments(
  segments: { duration: number }[],
  {
    windowSeconds = INTRO_CLIP_WINDOW_SECONDS,
    windows = INTRO_CLIP_WINDOWS,
  }: { windowSeconds?: number; windows?: number } = {}
): ClipPlan {
  const durations = segments.map((segment) =>
    Number.isFinite(segment.duration) && segment.duration > 0 ? segment.duration : 0
  );
  const sourceDuration = durations.reduce((sum, duration) => sum + duration, 0);
  if (durations.length === 0 || sourceDuration <= 0 || windowSeconds <= 0) {
    return { indices: [], duration: 0, sourceDuration };
  }

  // A one-segment scene has no way to be sampled: every window would be the whole
  // scene. Answer with no clip at all, and let the caller fall back to Bunny's
  // animation — better a still montage than the product itself.
  if (durations.length < 2) {
    return { indices: [], duration: 0, sourceDuration };
  }

  const starts: number[] = [];
  let elapsed = 0;
  for (const duration of durations) {
    starts.push(elapsed);
    elapsed += duration;
  }

  const affordable = Math.max(
    1,
    Math.min(
      windows,
      Math.floor(sourceDuration / (2 * windowSeconds)),
      durations.length - 1
    )
  );

  // A single window shows the OPENING, never the end: when there is only room for
  // one piece, the beginning is the piece that sells the scene.
  const lastStart = Math.max(0, sourceDuration - windowSeconds);
  const targets =
    affordable === 1
      ? [0]
      : Array.from({ length: affordable }, (_, index) => (lastStart * index) / (affordable - 1));

  const indices = new Set<number>();
  for (const target of targets) {
    let index = starts.findIndex(
      (start, position) => target >= start && target < start + durations[position]
    );
    if (index === -1) index = starts.length - 1;
    indices.add(index);
  }

  const ordered = Array.from(indices).sort((a, b) => a - b);
  return {
    indices: ordered,
    duration: ordered.reduce((sum, index) => sum + durations[index], 0),
    sourceDuration,
  };
}

// -----------------------------------------------------------------------------
// The stitched manifest
// -----------------------------------------------------------------------------

/** Collapse `./` and `../` so a signed path is exactly what the CDN is asked for. */
function normalizePath(uri: string): string {
  const parts: string[] = [];
  for (const part of uri.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface ClipManifestInput {
  /** The whole media playlist, and the plan over it. */
  segments: HlsSegment[];
  indices: number[];
  /** Folder of the rendition playlist, e.g. `360p/` — children resolve against it. */
  directory: string;
  /** Absolute, already-signed CDN URL for one path inside the video's folder. */
  signUrl: (relativePath: string) => string;
  version?: number;
}

/**
 * Build an HLS playlist of just the planned windows.
 *
 * `#EXT-X-DISCONTINUITY` separates the windows because each one is a jump: it
 * tells the player to expect timestamps that do not follow on from the previous
 * segment, which is exactly what a stitched trailer is. Each window repeats its
 * own key and init map so the result stays correct for an encrypted or fMP4
 * rendition, not only for the plain MPEG-TS one Bunny produces today.
 */
export function buildClipManifest({
  segments,
  indices,
  directory,
  signUrl,
  version = 3,
}: ClipManifestInput): string {
  const chosen = indices
    .map((index) => segments[index])
    .filter((segment): segment is HlsSegment => Boolean(segment));
  if (chosen.length === 0) return "";

  const resolve = (uri: string) => {
    if (ABSOLUTE_URI.test(uri)) return null; // Another host: not ours to sign.
    const joined = uri.startsWith("/") ? uri.replace(/^\/+/, "") : `${directory}${uri}`;
    return normalizePath(joined);
  };

  const longest = chosen.reduce((max, segment) => Math.max(max, segment.duration), 0);
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];

  chosen.forEach((segment, position) => {
    if (position > 0) lines.push("#EXT-X-DISCONTINUITY");

    const key = segment.key;
    if (key) {
      const keyUri = key.uri ? resolve(key.uri) : null;
      const attributes = [`METHOD=${key.method}`];
      // The key FILE is signed per file like everything else, so an encrypted
      // rendition works without ever authorising the folder.
      if (keyUri) attributes.push(`URI="${signUrl(keyUri)}"`);
      if (key.iv) attributes.push(`IV=${key.iv}`);
      lines.push(`#EXT-X-KEY:${attributes.join(",")}`);
    }

    if (segment.mapUri) {
      const mapPath = resolve(segment.mapUri);
      if (mapPath) lines.push(`#EXT-X-MAP:URI="${signUrl(mapPath)}"`);
    }

    const segmentPath = resolve(segment.uri);
    if (!segmentPath) return; // Absolute foreign URI — nothing we can authorise.
    lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    lines.push(signUrl(segmentPath));
  });

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}
