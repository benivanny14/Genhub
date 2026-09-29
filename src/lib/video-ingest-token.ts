// =============================================================================
// GENHUB - The token that authorizes moving one uploaded file into one slot
//
// A video goes: browser -> presigned PUT -> R2 -> Bunny. The last hop is made by
// worker/video-ingest, and this token is how that Worker knows the request to
// move bytes is ours and not anybody else's.
//
// WHY THE INGEST IS OURS AND NOT BUNNY'S. Bunny's fetch API downloads a URL into
// a video it creates itself and returns no guid — so it can neither fill the
// slot this server reserved nor be retried without the risk of ingesting the
// same file twice under two ids. See lib/services/video-ingest.service.ts for
// the full note. The consequence for this file is that the thing being
// authorized is a MOVE, not a read.
//
// WHAT IT PROMISES, AND WHAT IT DOES NOT. It names ONE object key and ONE video
// id until one deadline, and nothing else. It cannot list the bucket, delete an
// object, read another key, or write into another slot — so a leaked token
// cannot be used to pull a creator's unpublished file into somebody else's post,
// which is the specific attack this binding exists to stop. It never reaches a
// browser.
//
// It is HMAC rather than a signature over the whole request because the request
// carries no body: the bytes are in the bucket and the Worker streams them from
// there, so there is nothing to hash.
//
// ONE IMPLEMENTATION, TWO RUNTIMES. This file is imported by the Next server
// that signs the token and by the Worker that verifies it. Two copies of a
// signing rule is exactly the class of bug this codebase has already been bitten
// by (see TRANSIENT_4XX in upload-error.ts, where two lists drifted and an upload
// died because of it), so there is one copy.
// =============================================================================

const TOKEN_VERSION = "v1";

/**
 * What is signed, as one string.
 *
 * The video id is inside the payload as well as the object key, on purpose: the
 * key says which bytes, the id says which slot, and a token that named only one
 * of the two could be reused for the other.
 *
 * Versioned so a future token that carries more can be told apart from this one
 * instead of being read as a malformed version of it.
 */
export function videoIngestTokenPayload(key: string, videoId: string, expiresAt: number): string {
  return `${TOKEN_VERSION}:${key}:${videoId}:${expiresAt}`;
}

/** Lowercase hex, because the token travels in a URL. */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return toHex(signature);
}

/** The token the Worker carries. Called on the server, never in a browser. */
export async function signVideoIngestToken(
  secret: string,
  key: string,
  videoId: string,
  expiresAt: number
): Promise<string> {
  return hmacHex(secret, videoIngestTokenPayload(key, videoId, expiresAt));
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
 * Whether this token authorizes this move, and whether it is still valid.
 *
 * `nowSeconds` is passed in rather than read from the clock so the expiry rule
 * can be tested at the boundary instead of waited for.
 */
export async function verifyVideoIngestToken(params: {
  secret: string;
  key: string;
  videoId: string;
  expiresAt: number;
  token: string;
  nowSeconds: number;
}): Promise<boolean> {
  const { secret, key, videoId, expiresAt, token, nowSeconds } = params;

  if (!secret || !token) return false;
  // Expiry first, and inclusive: a token is good until its deadline passes.
  if (!Number.isFinite(expiresAt) || nowSeconds > expiresAt) return false;

  const expected = await signVideoIngestToken(secret, key, videoId, expiresAt);
  return equalInConstantTime(expected, token.toLowerCase());
}

/**
 * The URL the server calls to start one ingest.
 *
 * The token rides in the query string so the Worker can refuse a request it
 * cannot authorize without reading anything else first. It is a URL, so it lands
 * in logs — which is why it names one key and one slot, and why it expires.
 */
export function videoIngestUrl(params: {
  baseUrl: string;
  key: string;
  videoId: string;
  expiresAt: number;
  token: string;
}): string {
  const { baseUrl, key, videoId, expiresAt, token } = params;
  const url = new URL(baseUrl);
  // The Worker serves the ingest on /ingest, so a base URL of
  // https://host.workers.dev and one of https://host.workers.dev/ both land on
  // the same endpoint instead of 404ing on a doubled slash.
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ingest`;
  url.search = "";
  url.searchParams.set("key", key);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("sig", token);
  return url.toString();
}
