// =============================================================================
// GENHUB - Bunny Stream's resumable endpoint (TUS), written once
//
// The move that puts a creator's file in front of the encoder used to be made by
// worker/video-ingest alone. It is now made by the upload's own server as well
// (lib/services/video-ingest.service.ts), because a step that only exists in a
// Worker is a step that only works after somebody remembers to deploy it — and
// measured on 2026-09-29, nobody had: every completed upload, including a 192 MB
// file that had already crossed the Atlantic into the bucket, ended at a
// Cloudflare "Worker threw exception" page, and the creator saw an upload reach
// 100% and then fail with no reason anywhere in the app.
//
// Two callers, one implementation. Both runtimes this codebase has — a Node
// serverless function and a Cloudflare Worker — speak fetch and WebCrypto, so
// there is no platform branch in here, only the four requests Bunny's resumable
// protocol requires: create, ask where it got to, send a slice, and (implicitly)
// be told a slice was refused.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE COST A MEASUREMENT:
//
//   * The Location Bunny returns is RELATIVE — `/tusupload/<id>` — and used as
//     it arrives it throws "Failed to parse URL". It has to be resolved against
//     the API host. Measured live against library 760553.
//   * The Authorization headers are revalidated on EVERY POST, HEAD and PATCH: a
//     PATCH carrying an offset but no LibraryId is answered `400 Library ID
//     missing or invalid`. So the headers are built once and spread into each
//     call rather than written out at each one.
//   * The signature is SHA-256, lowercase hex, of libraryId + apiKey + expire +
//     videoId, in that order — Bunny's own rule, character for character.
//   * A 204 must be answered with no body at all. The successful PATCH is the
//     one request where a fake that writes `new Response("", …)` breaks, which
//     is noted where it bit (tests/video-ingest.test.ts).
//
// A HEAD that fails, and a Location that is missing, are both reported rather
// than thrown: every ending in this file has to be a value the caller can turn
// into an answer, because the failure this module exists to end is the one where
// an exception escaped and the creator was left with an HTML error page.
// =============================================================================

/** Bunny's management API. The video object already exists — this only fills it. */
export const BUNNY_API = "https://video.bunnycdn.com";

/** The resumable endpoint. A slot has to be reserved before this is usable. */
export const TUS_ENDPOINT = `${BUNNY_API}/tusupload`;

/** The only protocol version Bunny speaks. Sent on every request, all four of
 *  them, because a PATCH without it is not a PATCH Bunny recognizes. */
export const TUS_VERSION = "1.0.0";

/**
 * How long a TUS authorization is good for.
 *
 * Bunny revalidates the signature on every request, so this has to outlast the
 * whole transfer rather than just the first call — an upload whose signature
 * expires mid-flight is refused on the next PATCH with a 401 that reads like a
 * bad key. Bunny asks for at least an hour; half a day means a transfer carried
 * across several serverless invocations is still the same upload.
 */
export const TUS_AUTH_TTL_SECONDS = 12 * 60 * 60;

/** SHA-256 of a string, lowercase hex — the TUS AuthorizationSignature. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The headers Bunny wants on EVERY TUS request, not just the first.
 *
 * Built as a set rather than four strings at each call site so a future request
 * cannot be written with three of them — which is the exact mistake that
 * produced `400 Library ID missing or invalid` on a PATCH that looked correct.
 */
export async function tusAuthHeaders(params: {
  libraryId: string;
  apiKey: string;
  videoId: string;
  expiresAt: number;
}): Promise<Record<string, string>> {
  const { libraryId, apiKey, videoId, expiresAt } = params;

  // Bunny's own ordering, character for character: library id, then key, then
  // the deadline, then the video id, hashed as one string.
  const signature = await sha256Hex(`${libraryId}${apiKey}${expiresAt}${videoId}`);

  return {
    AuthorizationSignature: signature,
    AuthorizationExpire: String(expiresAt),
    LibraryId: libraryId,
    VideoId: videoId,
  };
}

/**
 * Bunny answers a create with a RELATIVE Location — `/tusupload/<id>` — which is
 * not a URL until it is resolved against the API host.
 */
export function resolveUploadUrl(location: string): string {
  return new URL(location, BUNNY_API).toString();
}

/** Base64, as TUS metadata values are encoded. */
function base64(value: string): string {
  // `btoa` is present in both runtimes this file runs in, and the values are
  // ASCII (a MIME type, a video id), so no code-point widening is needed.
  return btoa(value);
}

export type TusCreateOutcome =
  | { ok: true; uploadUrl: string }
  | { ok: false; status: number; detail: string };

/**
 * Open a resumable upload against a slot that already exists.
 *
 * The LENGTH is declared here, before a byte moves, because TUS requires it and
 * because it is what makes `complete` mean something: Bunny counts a finished
 * upload by the offset reaching this number. The metadata fields are required
 * too, and the title is the video id — the creator's own title arrives later,
 * with the post, and a blank one makes the library unusable to look at.
 */
export async function createTusUpload(params: {
  libraryId: string;
  apiKey: string;
  videoId: string;
  total: number;
  expiresAt: number;
  timeoutMs?: number;
}): Promise<TusCreateOutcome> {
  const { libraryId, apiKey, videoId, total, expiresAt, timeoutMs } = params;

  const headers = await tusAuthHeaders({ libraryId, apiKey, videoId, expiresAt });

  let response: Response;
  try {
    response = await fetch(TUS_ENDPOINT, {
      method: "POST",
      headers: {
        ...headers,
        "Tus-Resumable": TUS_VERSION,
        "Upload-Length": String(total),
        "Upload-Metadata": `filetype ${base64("video/mp4")},title ${base64(videoId)}`,
      },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    return { ok: false, status: 0, detail: `${name}: ${message.slice(0, 200)}` };
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, status: response.status, detail: body.slice(0, 600) };
  }

  const location = response.headers.get("location");
  if (!location) {
    return {
      ok: false,
      status: 502,
      detail: "Bunny accepted the upload without naming it",
    };
  }

  return { ok: true, uploadUrl: resolveUploadUrl(location) };
}

/**
 * Where this upload has already got to, asked of Bunny rather than remembered.
 *
 * A resource created a moment ago answers zero. One a previous attempt left half
 * sent answers with the bytes it holds, and that number is what turns a retry
 * into a continuation instead of a two-gigabyte transfer again. A HEAD that
 * fails is treated as zero: starting again is always correct, only slower.
 */
export async function tusUploadOffset(params: {
  uploadUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<number> {
  const { uploadUrl, headers, timeoutMs } = params;

  try {
    const response = await fetch(uploadUrl, {
      method: "HEAD",
      headers: { ...headers, "Tus-Resumable": TUS_VERSION },
      signal: AbortSignal.timeout(timeoutMs ?? 30_000),
    });
    if (!response.ok) return 0;
    const offset = Number(response.headers.get("upload-offset"));
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export type TusChunkOutcome =
  | { ok: true; offset: number }
  | {
      ok: false;
      /** Bunny's status when it ANSWERED. Absent means the request never got a
       *  reply — the connection, which is the case worth retrying. */
      status?: number;
      detail: string;
    };

/**
 * Send one slice, and answer with the offset Bunny now holds.
 *
 * The offset Bunny RETURNS is the one used, not the offset sent: it is the only
 * figure that cannot run ahead of the bytes Bunny actually has, and a transfer
 * that believes its own arithmetic after a half-delivered request writes the
 * wrong slice into the middle of a creator's video.
 */
export async function patchTusChunk(params: {
  uploadUrl: string;
  headers: Record<string, string>;
  offset: number;
  /**
   * The slice itself: a stream from a bucket binding, or bytes read out of one.
   *
   * A typed array is accepted alongside BodyInit because that is what the app's
   * own ingest has, and the only reason it needs the union is TypeScript: the DOM
   * lib narrows BufferSource to a view over a plain ArrayBuffer, while a
   * Uint8Array is generic over its backing buffer and does not satisfy it. The
   * cast at the fetch below is that gap and nothing else.
   */
  body: BodyInit | Uint8Array;
  /** Bytes in `body`, used only when Bunny does not answer with an offset. */
  size: number;
  timeoutMs?: number;
}): Promise<TusChunkOutcome> {
  const { uploadUrl, headers, offset, body, size, timeoutMs } = params;

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        ...headers,
        "Tus-Resumable": TUS_VERSION,
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: body as BodyInit,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    return { ok: false, detail: `${name}: ${message.slice(0, 200)}` };
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return { ok: false, status: response.status, detail: text.slice(0, 600) };
  }

  const advanced = Number(response.headers.get("upload-offset"));
  return {
    ok: true,
    offset: Number.isFinite(advanced) && advanced > offset ? advanced : offset + size,
  };
}
