// =============================================================================
// GENHUB - Bunny.net Stream Integration
// Handles video upload signatures, HLS URL generation with signed tokens
// =============================================================================

import { createHash, createHmac } from "node:crypto";
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
 * Bunny token signature: base64url(HMAC-SHA256(tokenSecret, expires + path)).
 * Only the first 16 characters are echoed by Bunny, but the full digest is
 * accepted, so no truncation is applied here.
 *
 * MUST NOT be computed with an empty secret: that produces a "signed" URL that
 * anybody can forge, which is worse than no protection at all.
 *
 * `tokenSecret` must be the pull zone's OWN "URL Token Authentication Key"
 * (CDN -> Pull Zone -> Security). A value generated with `openssl rand` cannot
 * match, and the failure is silent: Bunny answers 403, the player spins, and no
 * log line anywhere says why. .env.example said to generate one, which is how
 * production ended up signing URLs nobody would accept.
 */
function signBunnyPath(path: string, expiresAt: number): string {
  if (!config.bunny.tokenSecret) {
    throw new BunnyNotConfiguredError("Signed playback / download");
  }
  return createHmac("sha256", config.bunny.tokenSecret)
    .update(`${expiresAt}${path}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A directory token, embedded in the URL PATH — the only form that works for
 * HLS.
 *
 * The signature covers the video's whole folder (`/<guid>/`), not one file,
 * because a player does not fetch one file: it fetches the manifest and then
 * every segment and rendition named inside it (`240p/video.m3u8`,
 * `240p/video0.ts`, ...) as SEPARATE requests that each have to be authorised.
 *
 * And it goes in the path, not the query string, for exactly that reason. An
 * HLS player resolves those relative segment URLs against the manifest URL, and
 * URL resolution DROPS the base's query string: with `?token=...` the manifest
 * itself may load and then every segment comes back 403, which is a player that
 * shows a poster, a spinner, and never plays. Bunny's own player uses this
 * `bcdn_token`/`token_path` path form for the same reason (verified against the
 * live CDN).
 */
interface BunnyTokenParams {
  token: string;
  expires: number;
  /** The URL-encoded folder the token authorises. */
  tokenPath: string;
}

function directoryToken(bunnyVideoId: string, expiresAt: number): BunnyTokenParams {
  const directory = `/${bunnyVideoId}/`;
  return {
    token: signBunnyPath(directory, expiresAt),
    expires: expiresAt,
    tokenPath: encodeURIComponent(directory),
  };
}

/**
 * `https://<cdn>/bcdn_token=…&expires=…&token_path=…/<path>`
 *
 * The token parameters are injected as a path PREFIX in front of the real path,
 * which is the shape Bunny serves and the shape that makes the segments inherit
 * authentication.
 */
function signedBunnyUrl(
  path: string,
  expiresAt: number,
  bunnyVideoId: string
): string {
  if (!config.bunny.cdnHostname) {
    throw new BunnyNotConfiguredError("Playback");
  }
  const { token, expires, tokenPath } = directoryToken(bunnyVideoId, expiresAt);
  return (
    `https://${config.bunny.cdnHostname}` +
    `/bcdn_token=${token}&expires=${expires}&token_path=${tokenPath}` +
    path
  );
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
  return signedBunnyUrl(`/${bunnyVideoId}/playlist.m3u8`, expiresAt, bunnyVideoId);
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

export const DOWNLOAD_QUALITIES = ["1080p", "720p", "480p", "360p"] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];

export function generateDownloadUrl(
  bunnyVideoId: string,
  quality: DownloadQuality = "1080p",
  expirationMinutes: number = 10,
  _viewerId?: string
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expirationMinutes * 60;
  // Same directory token as playback: one shape, one thing to reason about, and
  // the file is inside the folder the token already authorises.
  return signedBunnyUrl(`/${bunnyVideoId}/play_${quality}.mp4`, expiresAt, bunnyVideoId);
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
 * Full-length playback URL. Call this ONLY once entitlement is established
 * (free video, purchase, active subscription, or admin).
 */
export function resolvePlaybackUrl(
  video: VideoSourceLocation,
  expirationMinutes = 10,
  viewerId?: string
): string | null {
  // Signed first: tokens are the whole anti-piracy story, so they must never be
  // skipped in favour of a static URL just because one happens to be stored.
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
  if (video.teaserBunnyVideoId) {
    const signed = safeTeaserUrl(video.teaserBunnyVideoId);
    if (signed) return signed;
  }

  if (video.teaserClipUrl) {
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

/** How long the CDN gets to answer a manifest request before we call it a fail. */
const PLAYBACK_PROBE_TIMEOUT_MS = 10_000;

export async function probeSignedPlayback(
  bunnyVideoId: string
): Promise<PlaybackProbe> {
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

  try {
    const res = await fetch(url, {
      // A manifest is a few hundred bytes; no need for the whole stream.
      headers: { Range: "bytes=0-2047" },
      signal: AbortSignal.timeout(PLAYBACK_PROBE_TIMEOUT_MS),
      cache: "no-store",
    });

    if (res.ok) {
      return {
        state: "ok",
        detail: `signed manifest accepted (HTTP ${res.status}) - BUNNY_TOKEN_SECRET matches the pull zone`,
      };
    }

    if (res.status === 403 || res.status === 401) {
      return {
        state: "fail",
        detail:
          `unplayable: Bunny answered HTTP ${res.status} to a correctly-shaped signed manifest. ` +
          "The token is signed with BUNNY_TOKEN_SECRET, so the likely cause is that the value is not " +
          "this pull zone's own URL Token Authentication Key (CDN -> Pull Zone -> Security -> Token " +
          "Authentication): a generated string cannot match, and the only symptom is a player that " +
          "spins forever. Copy the key, redeploy, and re-run this check.",
      };
    }

    return {
      state: "fail",
      detail: `signed manifest answered HTTP ${res.status}`,
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
 * One real video id from the library, for the probe above. Returns null when the
 * library is empty or unreachable — an empty library is a skip, not a failure.
 */
export async function sampleBunnyVideoId(): Promise<string | null> {
  if (!isBunnyConfigured()) return null;
  try {
    const res = await bunnyFetch(
      `${BUNNY_STREAM_API}/library/${config.bunny.libraryId}/videos?page=1&itemsPerPage=1`,
      { headers: { AccessKey: config.bunny.apiKey } },
      "probe video lookup"
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: { guid?: string }[] };
    return body.items?.[0]?.guid ?? null;
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
