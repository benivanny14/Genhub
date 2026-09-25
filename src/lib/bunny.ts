// =============================================================================
// GENHUB - Bunny.net Stream Integration
// Handles video upload signatures, HLS URL generation with signed tokens
// =============================================================================

import { createHash } from "node:crypto";
import config from "./config";
import { reportCredentialFault } from "./credential-alert";

// The Stream management API lives on video.bunnycdn.com/library/{libraryId}.
// NOT video.bunny.net, and NOT the /api/v2 prefix — that host does not resolve
// at all, so every upload/delete/lookup failed with a DNS error before this.
const BUNNY_STREAM_API = "https://video.bunnycdn.com";
const BUNNY_STORAGE_API = "https://storage.bunnycdn.com";

/**
 * How long one Bunny *management* call may take before it is abandoned.
 *
 * The same reason every Redis call is bounded (see lib/redis.ts): these run on
 * request paths and inside cron workers — `createVideoUpload` while a creator
 * waits for upload credentials, `getBunnyVideoDetails` in the encoding poll, and
 * `deleteBunnyVideo` from the video route — so a Bunny that accepts the
 * connection and then never answers would hold the request open until the
 * function timeout, exactly as an unresponsive Redis did on the payment path.
 * Bunny answers in well under a second when it is healthy, so 15s is generous.
 */
const BUNNY_MANAGEMENT_TIMEOUT_MS = 15_000;

/**
 * One bounded call to the Stream management API.
 *
 * A timeout is reported by name rather than as the raw "The operation was
 * aborted", because the reader — an operator, or the admin probe — needs to know
 * *which* provider went quiet and for how long. Any other failure is passed
 * through untouched, so a real HTTP error keeps its own message.
 */
async function bunnyFetch(
  url: string,
  init: RequestInit,
  what: string
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(BUNNY_MANAGEMENT_TIMEOUT_MS),
    });

    // The answer arrives immediately and is still a credential fault: a revoked
    // key or a key without access to this library. Nothing downstream can tell
    // that apart from a video that does not exist, and uploads simply stop.
    if (response.status === 401 || response.status === 403) {
      void reportCredentialFault({
        service: "Bunny Stream",
        detail:
          `BUNNY_STREAM_API_KEY was rejected for ${what} (HTTP ${response.status}) ` +
          "— the key is wrong, revoked, or lacks access to this library",
      });
    }

    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      // Reported because an encoding poll and an upload signature both wait on
      // this call: a Bunny that has gone quiet stalls uploads, and the only
      // symptom inside the app is a video stuck in `processing`.
      void reportCredentialFault({
        service: "Bunny Stream",
        detail: `the management API did not answer within ${BUNNY_MANAGEMENT_TIMEOUT_MS / 1000}s (${what})`,
      });
      throw new Error(
        `Bunny ${what} timed out after ${BUNNY_MANAGEMENT_TIMEOUT_MS / 1000}s — the API did not answer`
      );
    }
    void reportCredentialFault({
      service: "Bunny Stream",
      detail: `the management API could not be reached (${what}): ${(error as Error)?.message || error}`,
    });
    throw error;
  }
}

/**
 * True when Bunny Stream credentials are complete enough to play signed HLS.
 * The upload path only needs the API key + library id; playback also needs the
 * CDN hostname and the token secret, and returns unsigned URLs without them.
 */
export function isBunnyConfigured(): boolean {
  return Boolean(config.bunny.apiKey && config.bunny.libraryId);
}

export function isBunnyPlaybackConfigured(): boolean {
  return Boolean(config.bunny.cdnHostname && config.bunny.tokenSecret);
}

/** Thrown when a signed Bunny URL is requested without a token secret. */
export class BunnyNotConfiguredError extends Error {
  constructor(what: string) {
    super(
      `${what} requires Bunny.net to be configured ` +
        "(BUNNY_CDN_HOSTNAME + BUNNY_TOKEN_SECRET). " +
        "Bunny only enforces signed URLs when Token Authentication is enabled on " +
        "the pull zone, so refusing here is safer than handing out a URL anyone can share."
    );
    this.name = "BunnyNotConfiguredError";
  }
}

/**
 * Bunny token signature: base64url( SHA256(tokenSecret + path + expires) ).
 *
 * The ORDER IS part of the protocol, and so is the choice of primitive. This
 * function used to compute HMAC-SHA256 over `expires + path`, which is what
 * Bunny's *embed* player documentation describes — and this zone refuses every
 * one of those tokens with a bare 403. Verified against the live pull zone by
 * sweeping 1200 shape combinations (both orders, HMAC / SHA256 /
 * SHA256-with-key-prefix, hex / base64 / base64url, truncated and full, seconds
 * and milliseconds, query and path forms): exactly one family answered 206, and it is
 * this one — a plain SHA-256 over `secret + path + expires`, base64url encoded,
 * with nothing truncated.
 *
 * 403 is the only symptom of getting this wrong. Bunny does not say whether the
 * key or the hash was at fault, the player spins, and no log line names the
 * cause — which is what production looked like for two days.
 *
 * MUST NOT be computed with an empty secret: that produces a "signed" URL that
 * anybody can forge, which is worse than no protection at all.
 *
 * `tokenSecret` must be the pull zone's OWN "Token Authentication Key" (the
 * value under the pull zone / Stream library security settings). A value
 * generated with `openssl rand` cannot match, and the failure is the same
 * silent 403 — see probeSignedPlayback, which is the only check that can tell
 * "the secret is set" apart from "the secret works".
 */
function signBunnyPath(path: string, expiresAt: number): string {
  if (!config.bunny.tokenSecret) {
    throw new BunnyNotConfiguredError("Signed playback / download");
  }
  return createHash("sha256")
    .update(`${config.bunny.tokenSecret}${path}${expiresAt}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The token pair for a path, as Bunny accepts it.
 *
 * The signature covers a path and — measured against the live zone — every path
 * UNDER it: a token signed for `/abc-123/` opens `/abc-123/playlist.m3u8` if
 * that request carries it, and a token signed for one file opens nothing else.
 * The folder is therefore what we sign: an HLS video is not one request but the
 * manifest plus every rendition and segment named inside it, and one folder
 * token authorises all of them (asserted in tests/bunny.test.ts).
 */
interface BunnyTokenParams {
  token: string;
  expires: number;
}

function tokenFor(path: string, expiresAt: number): BunnyTokenParams {
  return { token: signBunnyPath(path, expiresAt), expires: expiresAt };
}

/**
 * `token=…&expires=…` — the authorisation Bunny reads from the QUERY STRING.
 *
 * The path-prefix form (`/bcdn_token=…&token_path=…/file`) that this module used
 * to emit is refused by this pull zone even with a correct signature (403 on all
 * four combinations tried against the live CDN), and it is not what Bunny's own
 * player uses here. Query strings it is — with one consequence the HLS route has
 * to handle: an HLS player resolves the relative URLs inside a manifest against
 * the manifest URL and DROPS its query string, so a `?token=` authorises the
 * manifest and nothing after it. Segments therefore cannot inherit anything by
 * being relative; they need the authorisation written INTO their URL, which is
 * what lib/hls.ts does (it signs the folder and rewrites every child URI).
 */
export function signedCdnQuery(path: string, expiresAt: number): string {
  const { token, expires } = tokenFor(path, expiresAt);
  return `token=${token}&expires=${expires}`;
}

/** `https://<cdn>/<path>?token=…&expires=…` */
function signedBunnyUrl(path: string, expiresAt: number): string {
  if (!config.bunny.cdnHostname) {
    throw new BunnyNotConfiguredError("Playback");
  }
  return `https://${config.bunny.cdnHostname}${path}?${signedCdnQuery(path, expiresAt)}`;
}

// =============================================================================
// Video Upload - Presigned TUS credentials
// =============================================================================
// The browser cannot PUT to `${BUNNY_STREAM_API}/library/.../videos/{id}`: that
// endpoint authenticates with the `AccessKey` header, and handing the library
// API key to a client would let any viewer upload, delete or read every video in
// the library. A PUT without the header is a hard 401 (verified against the live
// API), which is exactly the shape this path used to have.
//
// Bunny's answer is a presigned TUS upload: this server creates the video object
// with the key it holds, then signs a short-lived authorization the browser can
// use on its own:
//
//   AuthorizationSignature = sha256hex(libraryId + apiKey + expiration + videoId)
//
// The signature is bound to ONE video id, so a leaked credential can at most
// upload a single file into a slot that has already been reserved. The browser
// never sees the key (asserted by a test).
// -----------------------------------------------------------------------------

/** The TUS 1.0.0 endpoint Bunny accepts resumable/direct uploads on. */
export const BUNNY_TUS_ENDPOINT = "https://video.bunnycdn.com/tusupload";

/**
 * True when an id is a real Bunny video GUID rather than one Genhub fabricated.
 *
 * `bunnyVideoId` is non-nullable, so demo and side-loaded rows carry synthetic
 * ids (`demo-...`). Only real GUIDs point at something Bunny has to transcode —
 * polling the synthetic ones would 404 forever and, worse, would let the
 * encoding lifecycle decide whether demo content is allowed to be public.
 */
export function isBunnyVideoId(
  value: string | null | undefined
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export interface BunnyUploadCredentials {
  /** Where the browser PATCHes the bytes. */
  endpoint: string;
  /** GUID of the video object created below. */
  videoId: string;
  libraryId: string;
  /** UNIX seconds. Bunny rejects the upload once this passes. */
  expirationTime: number;
  /** sha256hex(libraryId + apiKey + expirationTime + videoId). */
  signature: string;
}

/**
 * Sign one video id for direct upload. Split out so the signature can be tested
 * without touching the network.
 */
export function createTusCredentials(
  videoId: string,
  ttlSeconds: number = 86_400
): BunnyUploadCredentials {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new BunnyNotConfiguredError(
      "Video uploads (BUNNY_STREAM_LIBRARY_ID + BUNNY_STREAM_API_KEY)"
    );
  }

  const expirationTime = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHash("sha256")
    .update(
      `${config.bunny.libraryId}${config.bunny.apiKey}${expirationTime}${videoId}`
    )
    .digest("hex");

  return {
    endpoint: BUNNY_TUS_ENDPOINT,
    videoId,
    libraryId: config.bunny.libraryId,
    expirationTime,
    signature,
  };
}

/**
 * Create the video object and return the credentials the browser needs to fill
 * it. TTL defaults to 24h so a long upload on a slow mobile connection cannot
 * have its authorization expire mid-transfer.
 */
export async function createVideoUpload(
  title: string
): Promise<BunnyUploadCredentials> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new BunnyNotConfiguredError(
      "Video uploads (BUNNY_STREAM_LIBRARY_ID + BUNNY_STREAM_API_KEY)"
    );
  }

  const response = await bunnyFetch(
    `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos`,
    {
      method: "POST",
      headers: {
        AccessKey: config.bunny.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
    "upload create"
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Bunny upload error: ${error}`);
  }

  const data = await response.json();
  return createTusCredentials(data.guid);
}

// =============================================================================
// Generate Signed HLS Playback URL (Anti-Piracy)
// =============================================================================

// The old `viewerId` fingerprint is deliberately no longer appended to the URL
// as `?uid=`: Bunny folds every query parameter into the token signature, so an
// extra one invalidates the URL, and the HLS player drops the query string
// entirely for segment requests. The parameter is kept so callers do not have to
// change, and the viewer identity reaches the player by other means (the moving
// watermark in VideoPlayer).
export function generateSignedVideoUrl(
  bunnyVideoId: string,
  expirationMinutes: number = 10,
  _viewerId?: string
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expirationMinutes * 60;
  return signedBunnyUrl(`/${bunnyVideoId}/playlist.m3u8`, expiresAt);
}

// =============================================================================
// Generate Teaser/Preview URL (Shorter expiration)
// =============================================================================

export function generateTeaserUrl(bunnyVideoId: string): string {
  return generateSignedVideoUrl(bunnyVideoId, 5);
}

// =============================================================================
// Generate Signed MP4 Download URL (members only)
// =============================================================================
// Bunny Stream keeps MP4 renditions of every video (play_1080p.mp4, play_720p.mp4,
// ...). They use the same token authentication as the HLS manifest, so a member
// who already has access can download the file instead of only streaming it.

// Ordered best-first, and 240p is included on purpose: Bunny produces an MP4
// fallback for every resolution a video has (verified against the live CDN — a
// 360x640 upload has play_240p.mp4 and play_360p.mp4), and a phone-only audience
// on metered data is exactly who wants the smallest file.
export const DOWNLOAD_QUALITIES = ["1080p", "720p", "480p", "360p", "240p"] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];

/**
 * The rendition to actually serve, when the requested one does not exist.
 *
 * Bunny only produces an MP4 fallback for the resolutions a video really has:
 * `availableResolutions` on a 360x640 upload reads `240p,360p`, and
 * `play_1080p.mp4` for it is a guaranteed 404. The download menu offers
 * 1080p/720p/480p regardless, so every download in the library failed with
 * "Video not found" — a dead button that looks like a broken video.
 *
 * So: the requested quality when it exists, otherwise the best one below it,
 * otherwise the best one there is. Never nothing, because the viewer asked for a
 * file and a smaller file is a better answer than an error.
 */
export function pickAvailableQuality(
  availableResolutions: string | null | undefined,
  requested: DownloadQuality
): DownloadQuality {
  const available = (availableResolutions || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is DownloadQuality =>
      (DOWNLOAD_QUALITIES as readonly string[]).includes(entry)
    );

  // Bunny said nothing useful — do not invent a downgrade.
  if (available.length === 0) return requested;
  if (available.includes(requested)) return requested;

  // Best-first order, so "below the request" is a larger index.
  const rank = (quality: DownloadQuality) => DOWNLOAD_QUALITIES.indexOf(quality);
  const below = available.filter((quality) => rank(quality) > rank(requested));
  const pool = below.length > 0 ? below : available;

  return pool.sort((a, b) => rank(a) - rank(b))[0];
}

export function generateDownloadUrl(
  bunnyVideoId: string,
  quality: DownloadQuality = "1080p",
  expirationMinutes: number = 10,
  _viewerId?: string
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expirationMinutes * 60;
  // Same folder token as playback: one shape, one thing to reason about, and the
  // file is inside the folder the token already authorises. A download is a
  // single request, so nothing needs rewriting for it — the query string is
  // enough (verified: HTTP 206).
  return signedBunnyUrl(`/${bunnyVideoId}/play_${quality}.mp4`, expiresAt);
}// =============================================================================
// Non-throwing variants
// =============================================================================
// Feed and detail routes map over many videos at once. One video with a Bunny
// id while the library is unconfigured must not take down the whole page, so
// these return null and let the caller fall back to the stored URL.

export function safeTeaserUrl(bunnyVideoId: string | null | undefined): string | null {
  if (!bunnyVideoId) return null;
  try {
    return generateTeaserUrl(bunnyVideoId);
  } catch {
    return null;
  }
}

export function safeSignedVideoUrl(
  bunnyVideoId: string | null | undefined,
  expirationMinutes = 10,
  viewerId?: string
): string | null {
  if (!bunnyVideoId) return null;
  try {
    return generateSignedVideoUrl(bunnyVideoId, expirationMinutes, viewerId);
  } catch {
    return null;
  }
}

export function safeDownloadUrl(
  bunnyVideoId: string | null | undefined,
  quality: DownloadQuality = "1080p",
  expirationMinutes = 10,
  viewerId?: string
): string | null {
  if (!bunnyVideoId) return null;
  try {
    return generateDownloadUrl(bunnyVideoId, quality, expirationMinutes, viewerId);
  } catch {
    return null;
  }
}

// =============================================================================
// Source resolution — WHICH url serves WHICH viewer
// =============================================================================
// A video row can describe its media two ways:
//
//   bunnyVideoId  Bunny-hosted master. Served through signed, expiring URLs
//                 gated by Token Authentication.
//   previewUrl    A stored stream (demo / migrated / side-loaded content).
//                 Public and UNSIGNED — whoever has the URL can play it without
//                 any entitlement check.
//
// These are two TRANSPORTS for the same media, not a "teaser vs real scene"
// pair. That is the part the old code got wrong: the buyer's playback URL was
// also taken from previewUrl, so previewUrl is the full scene. Every route chose
// with `previewUrl || somethingFromBunny`, which meant:
//
//   - a row with BOTH sources handed the public, unsigned, never-expiring URL to
//     a PAYING viewer instead of the signed one, and
//   - the same permanent, shareable URL went to viewers with no entitlement.
//
// AND MORE IMPORTANTLY, the row's Bunny id was ignored entirely, so playback was
// never token-signed even when the library was fully configured — the anti-piracy
// signature existed but was bypassed by the || ordering.
//
// The rule is now: the signed Bunny URL wins whenever it can be produced, and
// the stored stream is a FALLBACK for rows Bunny cannot serve (today: demo
// content, whose rows carry a fabricated `demo-*` id because bunnyVideoId is
// non-nullable in the schema). Expressed once, here, instead of five times
// inline in route handlers where it drifted.
// -----------------------------------------------------------------------------

export interface VideoSourceLocation {
  /**
   * The video ROW's id — not the Bunny GUID. Playback is served by our own
   * /api/videos/[id]/stream endpoint, which needs the row id to look up the
   * viewer's entitlement and the row's Bunny id. Rows in tests and seeds may
   * omit it, in which case the direct signed CDN URL is used instead.
   */
  id?: string | null;
  bunnyVideoId?: string | null;
  previewUrl?: string | null;
  /** Bunny id of a separate short clip to show non-buyers. */
  teaserBunnyVideoId?: string | null;
  /** Stored, publicly reachable trailer URL (side-loaded / demo rows). */
  teaserClipUrl?: string | null;
  /** 0 means free — a free video has nothing to protect, so it previews itself. */
  price?: number | null;
}

/**
 * Which media a stream request is for. A row can name two different Bunny
 * videos — the scene and its trailer — and they are two different folders with
 * two different tokens, so the route has to be told which one it is serving.
 */
export const STREAM_SOURCES = ["playback", "teaser"] as const;
export type StreamSource = (typeof STREAM_SOURCES)[number];

/** How long one rewritten manifest's authorisation stays valid. */
export const PLAYBACK_SESSION_MINUTES = 120;

/**
 * The in-app HLS endpoint for a video row:
 * `/api/videos/<rowId>/stream[?source=teaser]`.
 *
 * Playback no longer points the player straight at the CDN. It points at us,
 * and we hand back a manifest whose every child URL carries its own
 * authorisation (see lib/hls.ts for why that is unavoidable). The viewer's
 * cookie travels with the request, so entitlement is re-derived on our side
 * exactly as the detail route derived it before handing the URL over — and the
 * token secret itself never reaches the browser.
 */
export function streamSourceUrl(videoId: string, source: StreamSource = "playback"): string {
  // ROOT-RELATIVE on purpose. This string is handed to a <video> element and to
  // hls.js, both of which resolve it against the page that embedded it, so it
  // stays correct on the production domain, on a preview deployment and on
  // localhost — and a cached feed payload stays valid across all of them. An
  // absolute URL built from NEXT_PUBLIC_APP_URL would put a second copy of the
  // app's own address on the critical path to playback, which is exactly the
  // sort of configuration that breaks it silently.
  const base = `/api/videos/${encodeURIComponent(videoId)}/stream`;
  return source === "playback" ? base : `${base}?source=${source}`;
}

/**
 * The proxy URL for a row, or null when the row cannot be served this way.
 *
 * Null means "fall back" — a demo row (no Bunny id), an unconfigured library
 * (nothing can be signed, so the proxy could only fail), or a caller that did
 * not pass the row id at all.
 */
function streamProxyUrl(
  video: VideoSourceLocation,
  source: StreamSource = "playback"
): string | null {
  if (!video.id || !video.bunnyVideoId) return null;
  if (!isBunnyPlaybackConfigured()) return null;
  return streamSourceUrl(video.id, source);
}

/**
 * Full-length playback URL. Call this ONLY once entitlement is established
 * (free video, purchase, active subscription, or admin).
 */
export function resolvePlaybackUrl(
  video: VideoSourceLocation,
  expirationMinutes = 10,
  viewerId?: string
): string | null {
  // The proxy wins whenever it is possible: it is the only form that can serve
  // HLS end to end (the CDN refuses every token that is not in the query string,
  // and a query string does not survive an HLS player's relative-URL
  // resolution). Tokens are still the whole anti-piracy story — the route
  // decides entitlement and the rewritten URLs carry expiring signatures — so
  // this branch is not allowed to skip signing for a stored URL.
  const proxied = streamProxyUrl(video);
  if (proxied) return proxied;

  // No row id, or an unconfigured library: the direct signed URL is still the
  // right answer for a single-file source (and the only one for downloads).
  return (
    safeSignedVideoUrl(video.bunnyVideoId, expirationMinutes, viewerId) ??
    video.previewUrl ??
    null
  );
}

/**
 * Teaser for a viewer who has NOT paid.
 *
 * Precise about what a "teaser" is, because getting this wrong gives the scene
 * away: a Bunny token authorises a PATH and cannot limit duration, so signing a
 * premium video's own playlist for a non-buyer hands over the entire scene for
 * the life of the token (see PRODUCTION.md §8.0). `teaserDuration` is a UI value
 * — the badge and the hover length — and the player does not stop at it.
 *
 * Therefore, in order:
 *
 *   1. `teaserBunnyVideoId` — a SEPARATE short clip the creator uploaded.
 *   2. `teaserClipUrl` — a stored trailer URL, for rows whose media is
 *      side-loaded rather than Bunny-hosted (demo / migrated content).
 *   3. Free videos (price 0) — the video itself, since there is nothing to
 *      protect and withholding it would just break the free experience.
 *   4. Nothing. A paid scene with no teaser asset gets NO url rather than the
 *      main stream. Silence is the correct answer; a fallback here would undo
 *      the whole point of the teaser columns.
 *
 * Both teaser fields are checked BEFORE the free-video branch on purpose: a
 * free video with a trailer should still show the trailer, not the full scene.
 */
export function resolveTeaserUrl(video: VideoSourceLocation): string | null {
  // A "trailer" that IS the scene is not a trailer.
  //
  // `teaserBunnyVideoId` is treated as public here — the teaser door skips the
  // entitlement check by design — so a row whose teaser column holds the scene's
  // own id would hand the whole video to anyone, signed in or not. That is
  // rejected where the value is written (createVideoSchema, PATCH
  // /api/videos/[id]), and this is the last line of defence for a row written
  // before the rule existed or by something that does not go through the schema.
  // The only safe reading of "the teaser is the scene" is "there is no teaser".
  const teaserIsTheScene =
    !!video.teaserBunnyVideoId && video.teaserBunnyVideoId === video.bunnyVideoId;

  if (video.teaserBunnyVideoId && !teaserIsTheScene) {
    // The trailer is a separate Bunny video with its own folder and its own
    // token, so it gets its own proxy URL — and it stays public, because a
    // trailer that only buyers can watch is not a trailer.
    const proxied = streamProxyUrl(video, "teaser");
    if (proxied) return proxied;

    const signed = safeTeaserUrl(video.teaserBunnyVideoId);
    if (signed) return signed;
  }

  // Same rule for a side-loaded trailer: pointing it at the row's own stored
  // stream is pointing it at the scene.
  if (video.teaserClipUrl && video.teaserClipUrl !== video.previewUrl) {
    return video.teaserClipUrl;
  }

  if (video.price === 0) {
    return resolvePlaybackUrl(video, 5);
  }

  // A paid row with no trailer is withheld outright. Note this covers
  // side-loaded rows too: their previewUrl IS the scene, so it is no more
  // shareable with non-buyers than a Bunny-hosted one.
  return null;
}

/**
 * Members-only download source.
 *
 * `unavailableReason` lets the route answer 503 with a precise cause instead of
 * quietly serving the wrong file.
 */
export function resolveDownloadUrl(
  video: VideoSourceLocation,
  quality: DownloadQuality = "1080p",
  expirationMinutes = 10,
  viewerId?: string
): { url: string | null; unavailableReason: "BUNNY_NOT_CONFIGURED" | null } {
  const signed = safeDownloadUrl(video.bunnyVideoId, quality, expirationMinutes, viewerId);
  if (signed) return { url: signed, unavailableReason: null };

  if (video.previewUrl) return { url: video.previewUrl, unavailableReason: null };

  return {
    url: null,
    // Distinguish "this row is Bunny-hosted but the library cannot sign" from
    // "this row has no media at all" — the first is a deployment fault worth a
    // 503 and a loud message, the second is a plain 404.
    unavailableReason: video.bunnyVideoId ? "BUNNY_NOT_CONFIGURED" : null,
  };
}



// =============================================================================
// Does our signature actually work?
// =============================================================================
// Every other Bunny check asks whether the *credentials* are present. This one
// asks whether Bunny accepts them, because the two are not the same and the gap
// between them is invisible in the UI:
//
//   BUNNY_TOKEN_SECRET is a random value the operator generates (`openssl rand`)
//   BUNNY_TOKEN_SECRET is the pull zone's URL Token Authentication Key (Bunny's)
//
// Only the second produces a token Bunny will honour. With the first, the library
// reports healthy, the upload succeeds, the encoding finishes — and every signed
// playback URL answers 403, so the player sits on its spinner forever with no
// error anywhere. That was the real state of production playback: 40 sign/ verify
// variants against the live CDN all returned 403, including a freshly signed
// manifest for a video Bunny itself reports as `isPlayable: true`.
//
// So: sign one real manifest and fetch it. Nothing else distinguishes "configured"
// from "working".

export interface PlaybackProbe {
  state: "ok" | "fail" | "skip";
  detail: string;
}

/**
 * A short, non-reversible fingerprint of the loaded token secret.
 *
 * 403 has two causes that look identical from the outside: the secret is the
 * wrong string, or the secret is the right string with a stray space or newline
 * pasted into the hosting dashboard. The person reading this message is holding
 * a key in one hand and a dashboard in the other, and needs to know whether the
 * value the app is USING is the one they think they set. A fingerprint answers
 * that without ever printing the key — so it is safe in an admin-only response,
 * and useless to anyone who has no way to guess a 36-character key from 32 bits.
 */
export function tokenSecretFingerprint(): string | null {
  if (!config.bunny.tokenSecret) return null;
  return createHash("sha256").update(config.bunny.tokenSecret).digest("hex").slice(0, 8);
}

/** How long the CDN gets to answer a manifest request before we call it a fail. */
const PLAYBACK_PROBE_TIMEOUT_MS = 10_000;

/**
 * One manifest request, optionally dressed the way a BROWSER sends it.
 *
 * The `Origin` / `Referer` pair is not decoration. A pull zone can be gated by
 * "Allowed Referrers" as well as by token authentication, and that gate reads the
 * REFERER: measured against the live zone, the same correctly-signed URL answers
 * 206 with no Referer, 200 for an allowed host, and 403 for a host that is not on
 * the list — localhost and the custom domain were both refused while
 * `*.vercel.app` was allowed. A server-to-server probe therefore reports a
 * perfectly healthy CDN while every real viewer's browser (which always sends its
 * own origin) is refused, and the only symptom inside the app is a spinner.
 * Asking twice is what tells those two apart.
 */
async function manifestStatus(url: string, appOrigin?: string): Promise<number> {
  const res = await fetch(url, {
    // A manifest is a few hundred bytes; no need for the whole stream.
    headers: {
      Range: "bytes=0-2047",
      ...(appOrigin ? { Origin: appOrigin, Referer: `${appOrigin}/` } : {}),
    },
    signal: AbortSignal.timeout(PLAYBACK_PROBE_TIMEOUT_MS),
    cache: "no-store",
  });
  return res.status;
}

export async function probeSignedPlayback(bunnyVideoId: string): Promise<PlaybackProbe> {
  if (!isBunnyPlaybackConfigured()) {
    return {
      state: "skip",
      detail: "BUNNY_CDN_HOSTNAME / BUNNY_TOKEN_SECRET not set",
    };
  }

  let url: string;
  try {
    url = generateSignedVideoUrl(bunnyVideoId, 5);
  } catch (error) {
    return { state: "skip", detail: String((error as Error)?.message || error) };
  }

  // A trailing slash would make the Referer `https://host//`, which is not the
  // string a browser sends.
  const appOrigin = (config.appUrl || "").replace(/\/+$/, "");

  try {
    const status = await manifestStatus(url);

    if (status === 403 || status === 401) {
      return {
        state: "fail",
        detail:
          `unplayable: Bunny answered HTTP ${status} to a correctly-shaped signed manifest. ` +
          "The token is signed with BUNNY_TOKEN_SECRET, so the likely cause is that the value is not " +
          "this pull zone's own Token Authentication Key (Stream -> Security, or the pull zone's " +
          "Token Authentication): a generated string cannot match, and the only symptom is a player " +
          "that spins or stops with a 502. Copy the key, redeploy, and re-run this check. " +
          `The key currently in use fingerprints as ${tokenSecretFingerprint() ?? "(empty)"} — if that ` +
          "is not the key you pasted, the deployment is holding an older value (or one with a stray " +
          "space or newline in it).",
      };
    }

    if (status < 200 || status >= 300) {
      return {
        state: "fail",
        detail: `signed manifest answered HTTP ${status}`,
      };
    }

    // The signature works. Now the question the viewer actually asks: does the
    // CDN accept a request that comes FROM this deployment?
    if (appOrigin) {
      const browserStatus = await manifestStatus(url, appOrigin);
      if (browserStatus < 200 || browserStatus >= 300) {
        return {
          state: "fail",
          detail:
            `playback is blocked for real viewers: the signed manifest is accepted server-to-server ` +
            `(HTTP ${status}) but answered HTTP ${browserStatus} when the request came from ` +
            `${appOrigin}. The pull zone's Allowed Referrers list does not include this address, and ` +
            "every browser request — the manifest AND each segment fetched straight from the CDN — " +
            "carries it. Add this domain to the pull zone's Allowed Referrers (Bunny -> Pull Zone -> " +
            "Security / Referrer restrictions), and add http://localhost:3000 too so playback can be " +
            "tested locally. Nothing in the app can work around it: the browser has to fetch media " +
            `from ${config.bunny.cdnHostname} directly.`,
        };
      }
    }

    return {
      state: "ok",
      detail:
        `signed manifest accepted (HTTP ${status}) - BUNNY_TOKEN_SECRET matches the pull zone` +
        (appOrigin ? ` and ${appOrigin} may play it` : "") +
        ` · key ${tokenSecretFingerprint() ?? "?"}`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      state: "fail",
      detail:
        name === "TimeoutError" || name === "AbortError"
          ? `the CDN did not answer within ${PLAYBACK_PROBE_TIMEOUT_MS / 1000}s`
          : String((error as Error)?.message || error).slice(0, 160),
    };
  }
}

/**
 * One real video, plus what Bunny says about the library's token setting.
 *
 * The FACT that matters is on the video, not on the library: `GET /library/{id}`
 * answers only `{videoCount, liveStreamCount, collectionCount}`, with no
 * `TokenAuthenticationEnabled` field at all — which is why the health check used
 * to fall through to "ok" no matter how playback was configured. The per-video
 * `play` endpoint reports `tokenAuthEnabled` for real.
 *
 * Returns null when the library is empty or unreachable — an empty library is a
 * skip, not a failure.
 */
export interface SampledBunnyVideo {
  guid: string;
  tokenAuthEnabled: boolean | null;
  /** Bunny's own view of the CDN host, for comparing against BUNNY_CDN_HOSTNAME. */
  thumbnailUrl: string | null;
}

export async function sampleBunnyVideo(): Promise<SampledBunnyVideo | null> {
  if (!isBunnyConfigured()) return null;
  try {
    const list = await bunnyFetch(
      `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos?page=1&itemsPerPage=1`,
      { headers: { AccessKey: config.bunny.apiKey } },
      "probe video lookup"
    );
    if (!list.ok) return null;
    const guid = ((await list.json()) as { items?: { guid?: string }[] }).items?.[0]?.guid;
    if (!guid) return null;

    const play = await bunnyFetch(
      `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos/${guid}/play`,
      { headers: { AccessKey: config.bunny.apiKey } },
      "probe playback settings"
    );
    if (!play.ok) return { guid, tokenAuthEnabled: null, thumbnailUrl: null };

    const body = (await play.json()) as {
      tokenAuthEnabled?: boolean;
      thumbnailUrl?: string;
    };
    return {
      guid,
      tokenAuthEnabled: typeof body.tokenAuthEnabled === "boolean" ? body.tokenAuthEnabled : null,
      thumbnailUrl: body.thumbnailUrl || null,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Delete Video from Bunny.net
// =============================================================================

export async function deleteBunnyVideo(videoId: string): Promise<void> {
  const response = await bunnyFetch(
    `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos/${videoId}`,
    {
      method: "DELETE",
      headers: {
        AccessKey: config.bunny.apiKey,
      },
    },
    "delete"
  );

  if (!response.ok) {
    throw new Error(`Failed to delete video: ${videoId}`);
  }
}

// =============================================================================
// Get Video Details from Bunny.net
// =============================================================================

export async function getBunnyVideoDetails(videoId: string) {
  const response = await bunnyFetch(
    `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos/${videoId}`,
    {
      headers: {
        AccessKey: config.bunny.apiKey,
      },
    },
    "lookup"
  );

  if (!response.ok) {
    throw new Error(`Failed to get video details: ${videoId}`);
  }

  return response.json();
}
