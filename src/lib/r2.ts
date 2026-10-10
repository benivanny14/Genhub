// =============================================================================
// GENHUB - Cloudflare R2 (the one store a big file can actually reach)
// =============================================================================
// A visitor's browser has to be able to send a 500 MB clip somewhere and play it
// back, and neither half can happen through this application:
//
//   UPLOAD   A serverless function may not receive more than 4.5 MB. Anything
//            larger is refused by the platform before the route runs, and the
//            refusal is not even JSON — which is exactly how the background
//            video's own upload button reported "the upload failed, try again"
//            for every clip over four megabytes. So the browser uploads STRAIGHT
//            to R2 against a URL this server signs, and no byte of it passes
//            through here.
//
//   PLAYBACK The same 4.5 MB limit applies to what a function RETURNS, so a
//            large clip cannot be streamed out of one either. When the bucket
//            has a public address the serving route simply redirects to it and
//            the CDN does the rest (see R2_PUBLIC_BASE_URL); otherwise the
//            route proxies the clip one range at a time, which is correct but
//            sends every visitor's bytes through the app.
//
// WHY THE SIGNING IS HAND-WRITTEN
//
//   SigV4 over a URL is about forty lines of hashing, and the alternative — the
//   AWS SDK — is a dependency with its own release cadence and a much larger
//   surface, pulled in for two verbs. The tests pin the signature against the
//   algorithm's own vector shape (see src/tests/r2.test.ts), which is the part
//   that is easy to get subtly wrong and impossible to notice: a bad signature
//   is a flat 403 with no hint about which field was at fault.
//
// A key is built from a token this app generated and an allowlisted extension —
// never from anything a caller sent — so nothing here can address an object
// outside the one directory the background clips live in.
// =============================================================================

import { createHash, createHmac } from "node:crypto";
import config from "@/lib/config";
import { backgroundVideoExtension } from "@/lib/background-video";

/** The origin R2 answers on, once an account is named. Not a CDN. */
function host(): string {
  return `${config.r2.accountId}.r2.cloudflarestorage.com`;
}

/** Everything the signing functions need, or null when R2 is not configured. */
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2Credentials(): R2Credentials | null {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config.r2;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isR2Configured(): boolean {
  return r2Credentials() !== null;
}

/**
 * Where a background clip is stored.
 *
 * One directory, and the name is the token plus the extension the server
 * resolved from an allowlisted MIME type. The prefix means a key can never be
 * confused with another feature's object, and `isSafeR2Key` refuses anything
 * that could climb out of it.
 */
export const R2_BACKGROUND_PREFIX = "site/background/";

export function r2BackgroundKey(token: string, extension: string): string {
  return `${R2_BACKGROUND_PREFIX}${token}${extension}`;
}

/**
 * The key a stored row names, or null when it does not name one we would write.
 *
 * The ONE place a stored clip is turned into an object address, used by the
 * route that serves it, the one that deletes it, and the one that replaces it.
 * The token and the media type both have to be ones this app would itself have
 * written, so a settings row that was edited by hand resolves to "no clip"
 * rather than to an object of the editor's choosing.
 */
export function r2BackgroundKeyFor(token: string, mimeType: string): string | null {
  if (!/^[0-9a-f]{24}$/.test(token)) return null;
  const extension = backgroundVideoExtension(mimeType);
  if (!extension) return null;
  return r2BackgroundKey(token, extension);
}

/**
 * Is this a key we are willing to build a request from?
 *
 * The key reaches an outbound URL, so it is checked the same way a media key is:
 * no empty segments, no `..`, no leading slash, no scheme, no query, and only
 * the characters a generated name uses.
 */
export function isSafeR2Key(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("\\") || key.includes("?") || key.includes("#")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Lowercase hex SHA-256. The signature's primary primitive. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** `20261010T120000Z`, the only timestamp shape SigV4 accepts. */
function amzDate(at: Date): string {
  return at.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Percent-encode per SigV4: everything except the unreserved characters.
 *
 * `encodeURIComponent` leaves `!*'()` alone, and each of those is a character
 * the signature expects to be escaped — so `x.mp4` in a key would sign one
 * string and send another, which is a 403 with nothing in it to act on.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The canonical query string: sorted by encoded key, `key=value` joined with `&`.
 */
function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(params[key])}`)
    .join("&");
}

/**
 * A presigned URL: authorisation carried in the query rather than a header.
 *
 * This is the whole reason a browser can upload a 500 MB clip without holding a
 * credential — the signature covers one object, one verb and a short window, so
 * handing it to a client grants exactly that and nothing else.
 *
 * `headers` are the request headers the signature covers and therefore the ones
 * the client MUST send unchanged. `content-type` is included when it is passed
 * in, because that is what R2 stores on the object and what the serving route
 * later reports as the clip's media type.
 */
export function presignR2Url(params: {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  key: string;
  expiresInSeconds: number;
  contentType?: string;
  now?: Date;
}): { url: string; headers: Record<string, string>; expiresAt: number } {
  const credentials = r2Credentials();
  if (!credentials) throw new Error("R2 is not configured");
  const { key, method, expiresInSeconds, contentType } = params;
  if (!isSafeR2Key(key)) throw new Error(`refusing to sign an unsafe object key: ${key}`);

  const now = params.now ?? new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const origin = `https://${host()}`;
  const resource = `/${credentials.bucket}/${key}`;

  // The signed headers, in the order they are hashed. `host` is required; a
  // content type is added only when the caller means to send one.
  const signedHeaderNames = contentType ? "content-type;host" : "host";
  const headerLines = contentType
    ? `content-type:${contentType.trim()}\nhost:${host()}\n`
    : `host:${host()}\n`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaderNames,
  };

  // A presigned request does not hash a body: the client streams it, and R2
  // treats the payload as unsigned. Saying so is part of the format.
  const canonicalRequest = [
    method,
    resource,
    canonicalQuery(query),
    headerLines,
    signedHeaderNames,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), "auto"), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const url = `${origin}${resource}?${canonicalQuery({
    ...query,
    "X-Amz-Signature": signature,
  })}`;

  return {
    url,
    headers: contentType ? { "content-type": contentType } : {},
    expiresAt: Math.floor(now.getTime() / 1000) + expiresInSeconds,
  };
}

/**
 * Where the object lives, or null when R2 is not configured.
 *
 * Only used by the routes that must reach the object itself; the browser is
 * never given this address because it needs the credential.
 */
export function r2ObjectUrl(key: string): string | null {
  const credentials = r2Credentials();
  if (!credentials || !isSafeR2Key(key)) return null;
  return `https://${host()}/${credentials.bucket}/${key}`;
}

/**
 * The address a VISITOR can fetch the clip from, or null when the bucket has no
 * public hostname configured.
 *
 * This is the difference between a backdrop the CDN serves and one every
 * visitor pulls through the app: with a public base URL the serving route
 * redirects here and nothing of the clip touches a function. Without one the
 * route proxies ranges instead, which works but pays for the bandwidth twice.
 */
export function r2PublicUrl(key: string): string | null {
  const base = config.r2.publicBaseUrl;
  if (!base || !isSafeR2Key(key)) return null;
  return `${base.replace(/\/+$/, "")}/${key}`;
}

/** A signed request to R2 itself, for the calls the browser cannot make. */
async function r2Fetch(
  method: "GET" | "HEAD" | "DELETE",
  key: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response | null> {
  const credentials = r2Credentials();
  if (!credentials) return null;
  if (!isSafeR2Key(key)) return null;

  const now = new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const resource = `/${credentials.bucket}/${key}`;
  const payloadHash = sha256Hex("");

  // The headers the signature covers. `range` is included when present so a
  // supported partial fetch stays verifiable rather than being silently ignored.
  const headers: Record<string, string> = {
    host: host(),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
    ...extraHeaders,
  };
  const signedHeaderNames = Object.keys(headers).sort().join(";");
  const headerLines = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");

  const canonicalRequest = [
    method,
    resource,
    "",
    headerLines,
    signedHeaderNames,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), "auto"), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  try {
    return await fetch(`https://${host()}${resource}`, {
      method,
      headers: {
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": stamp,
        ...extraHeaders,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // A store that cannot be reached is reported by the caller as "not there",
    // which is the safe direction for every one of these: a missing object
    // serves 404, and a delete that fails leaves an unreferenced object.
    return null;
  }
}

/**
 * What R2 holds for this key, or null when there is nothing.
 *
 * Used to confirm an upload the BROWSER claims to have finished. The claim alone
 * is not enough: the PUT could have been refused halfway and the clip would then
 * be recorded as live while the layer waited on bytes that never arrived.
 */
export async function r2HeadObject(key: string): Promise<{ size: number } | null> {
  const response = await r2Fetch("HEAD", key);
  if (!response?.ok) return null;
  const size = Number(response.headers.get("content-length"));
  return Number.isFinite(size) && size > 0 ? { size } : null;
}

/** Remove an object. Missing is success — the caller is replacing or clearing. */
export async function r2DeleteObject(key: string): Promise<void> {
  await r2Fetch("DELETE", key);
}

/**
 * One slice of the object, for the serving route's proxy path.
 *
 * Returns the upstream response so the caller can pass through the status, the
 * Content-Range and the bytes without re-implementing HTTP. `null` means R2 was
 * unreachable or the key was refused, which the caller answers as 404 rather
 * than as a broken 200.
 */
export async function r2GetObjectRange(
  key: string,
  start: number,
  end: number
): Promise<Response | null> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return r2Fetch("GET", key, { range: `bytes=${start}-${end}` });
}
