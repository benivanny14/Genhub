// =============================================================================
// GENHUB - The upload proxy's per-video authorization
//
// The single-PUT upload path needs a server that holds the Bunny library key,
// because that key manages every video in the library: it can be handed to a
// browser only by somebody who has decided they do not want a library. So the
// browser uploads to a proxy (worker/bunny-upload) that adds the key on its way
// out, and this module is how that proxy knows the request is ours.
//
// WHAT THE TOKEN PROMISES, AND WHAT IT DOES NOT. It authorizes uploading bytes
// into ONE video id that this server has already reserved, until one deadline.
// It cannot list, read, rename or delete anything, and it cannot create a video
// object — the same deliberate limitation as the TUS authorization it sits
// beside, and for the same reason: a credential that reaches the browser must be
// worth as little as possible.
//
// It is HMAC rather than a signature over the whole request: the body is the
// file, and hashing gigabytes to authorize them would cost the upload we are
// trying to make cheaper.
//
// ONE IMPLEMENTATION, TWO RUNTIMES. This file is imported by the Next server
// that signs the token and by the Worker that verifies it. Two copies of a
// signing rule is exactly the class of bug this codebase has already been bitten
// by (see TRANSIENT_4XX in tus-upload.ts, where two lists drifted and an upload
// died because of it), so there is one copy.
// =============================================================================

const TOKEN_VERSION = "v1";

/**
 * What is signed, as one string.
 *
 * Versioned so a future token that carries more (a size, a content type) can be
 * told apart from this one instead of being read as a malformed version of it.
 */
export function uploadProxyTokenPayload(videoId: string, expiresAt: number): string {
  return `${TOKEN_VERSION}:${videoId}:${expiresAt}`;
}

/** Lowercase hex, because the token travels in a URL. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(signature);
}

/** The token the browser carries. Called on the server, never in the browser. */
export async function signUploadProxyToken(
  secret: string,
  videoId: string,
  expiresAt: number
): Promise<string> {
  return hmacHex(secret, uploadProxyTokenPayload(videoId, expiresAt));
}

/**
 * Compared without an early exit.
 *
 * A comparison that returns on the first differing character leaks how much of a
 * guessed token was right, one character at a time, which is enough to forge one
 * given enough requests. The cost of not leaking is that this loop is not short-
 * circuited: it always reads both strings to the end.
 */
function equalInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Whether this token authorizes this video id, and whether it is still valid.
 *
 * `nowSeconds` is passed in rather than read from the clock so the expiry rule
 * can be tested at the boundary instead of waited for.
 */
export async function verifyUploadProxyToken(params: {
  secret: string;
  videoId: string;
  expiresAt: number;
  token: string;
  nowSeconds: number;
}): Promise<boolean> {
  const { secret, videoId, expiresAt, token, nowSeconds } = params;

  if (!secret || !token) return false;
  // Expiry first, and inclusive: a token is good until its deadline passes.
  if (!Number.isFinite(expiresAt) || nowSeconds > expiresAt) return false;

  const expected = await signUploadProxyToken(secret, videoId, expiresAt);
  return equalInConstantTime(expected, token.toLowerCase());
}

/**
 * Where the browser PUTs the bytes.
 *
 * The token rides in the query string rather than a header so the Worker can
 * authorize before reading a body it would otherwise have to buffer. It is a
 * URL, so it lands in logs — which is why the token can only fill a slot that
 * was already reserved, and why it expires.
 */
export function uploadProxyUrl(params: {
  baseUrl: string;
  videoId: string;
  expiresAt: number;
  token: string;
}): string {
  const { baseUrl, videoId, expiresAt, token } = params;
  const url = new URL(baseUrl);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("sig", token);
  return url.toString();
}
