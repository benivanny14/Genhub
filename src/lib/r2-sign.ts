// =============================================================================
// GENHUB - Presigned URLs for Cloudflare R2 (AWS Signature Version 4)
//
// This is how a browser uploads a video without ever holding a credential that
// matters. The server signs a URL that authorizes ONE object, for ONE method,
// until one deadline; the browser PUTs the file to it directly. Compare the two
// alternatives and the reason for this file is obvious:
//
//   * The Bunny library key cannot go to a browser — it can delete every video
//     in the library (see the comment in lib/bunny.ts).
//   * A proxy has to receive the bytes, which costs a second copy of the file
//     and a body limit measured in megabytes.
//
// WHY THIS IS WRITTEN BY HAND. The signing rule is a published, versioned
// algorithm with a documented test vector (see r2-sign.test.ts, which checks
// this implementation against the exact example in the AWS S3 documentation).
// Pulling in a whole SDK to produce a URL would put a large dependency in the
// upload path of an application that already hand-rolls its other HMAC work
// (lib/bunny-webhook.ts, lib/video-source-token.ts) — and the failure mode of a
// wrong signature is a 403 on the creator's upload, which is exactly the class
// of bug this codebase has been paying for.
//
// WHAT THE SIGNATURE DOES AND DOES NOT MEAN. It authorizes the named method on
// the named object until it expires. It cannot list the bucket, read another
// creator's object, or delete anything. The browser holds a URL, not a key: a
// leaked presigned URL dies at its deadline, and every upload gets a fresh one.
//
// The signature travels in the query string rather than a header because a
// browser upload has no way to set an Authorization header on an XHR without
// becoming a cross-origin request with a preflight of its own. Query-string
// authentication is the same algorithm in a different place — AWS calls it
// "presigning a URL" — and it is the only form a browser can use.
// =============================================================================

import { createHash, createHmac } from "node:crypto";

/** The one algorithm this file implements. Named once, used in three places. */
const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * The character set AWS calls "unreserved", which is the set that must NOT be
 * encoded.
 *
 * The platform's own `encodeURIComponent` is not usable here: it leaves `!'()*`
 * unescaped, and AWS's canonical request requires them escaped. A signature
 * computed with the wrong encoder is rejected with a message that says nothing
 * about encoding, so the encoder is written out rather than borrowed.
 */
function isUnreserved(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e // ~
  );
}

/**
 * URI-encode for the canonical request.
 *
 * Hex digits are uppercase, a space is `%20` and not `+`, and `/` is left alone
 * when it is part of an object key — `photos/Jan/x.jpg` is one key, not three
 * path segments — which is what `encodeSlash: false` is for.
 */
export function uriEncode(input: string, encodeSlash = true): string {
  const bytes = Buffer.from(input, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (isUnreserved(byte)) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x2f && !encodeSlash) {
      out += "/";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20130524T000000Z` — the only timestamp format the canonical request takes. */
export function amzDateFrom(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

export interface PresignParams {
  /** Host only, no scheme: `examplebucket.s3.amazonaws.com`. */
  host: string;
  /** The path, decoded: `/bucket/key`. Encoded here, not by the caller. */
  path: string;
  method: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  expiresInSeconds: number;
  /** The signing moment. Passed in, never read from the clock, so it is testable. */
  date: Date;
}

/** Everything a caller needs to reproduce or assert the signature. */
export interface PresignedRequest {
  url: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Which query parameters are signed, in the order the canonical request needs
 * them: byte-sorted by name, which for these five names is the order below.
 * `X-Amz-Signature` is deliberately absent — a signature cannot sign itself.
 */
function authQuery(params: PresignParams, scope: string, amzDate: string) {
  return [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${params.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(params.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ] as const;
}

/**
 * Sign one request, returning the URL and the intermediate values.
 *
 * The intermediates are returned rather than hidden because a signature that
 * does not match a provider's is otherwise a black box: being able to print the
 * exact canonical request AWS documents is what makes this debuggable.
 */
export function presign(params: PresignParams): PresignedRequest {
  const service = params.service ?? "s3";
  const amzDate = amzDateFrom(params.date);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${params.region}/${service}/aws4_request`;

  const query = authQuery(params, scope, amzDate);
  const canonicalQueryString = query
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");

  const canonicalHeaders = `host:${params.host}\n`;
  const signedHeaders = "host";

  // `UNSIGNED-PAYLOAD` because a presigned URL is created before the sender
  // exists: there is no body to hash yet, and hashing a video to authorize it
  // would cost exactly the upload this is trying to make possible.
  const canonicalRequest = [
    params.method.toUpperCase(),
    uriEncode(params.path, false),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // The documented derivation, in order: the secret prefixes the chain, then
  // the date, the region, the service and the terminator. Every one of them
  // narrows the key, which is why a signature from one region never validates
  // in another.
  let signingKey: Buffer | string = `AWS4${params.secretAccessKey}`;
  for (const part of [dateStamp, params.region, service, "aws4_request"]) {
    signingKey = hmac(signingKey, part);
  }

  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const url =
    `https://${params.host}${uriEncode(params.path, false)}` +
    `?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return { url, canonicalRequest, stringToSign, signature };
}

// =============================================================================
// The R2-shaped wrapper
// =============================================================================

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function isR2Configured(r2: Partial<R2Credentials>): r2 is R2Credentials {
  return Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket);
}

/**
 * R2's S3 endpoint, path-style: the bucket is a path segment, not a subdomain.
 *
 * R2 uses `auto` as the region — it is a single global namespace behind
 * Cloudflare's edge, so there is no region to name, and the literal string the
 * provider expects is what goes into the credential scope.
 */
export function r2Host(accountId: string): string {
  return `${accountId}.r2.cloudflarestorage.com`;
}

export const R2_REGION = "auto";

export function r2ObjectPath(bucket: string, key: string): string {
  return `/${bucket}/${key}`;
}

/**
 * Where the browser PUTs the file.
 *
 * The bucket is private. The only thing this URL can do is replace one object
 * that this server just named, and it stops working at the deadline.
 */
export function presignR2Put(
  r2: R2Credentials,
  key: string,
  expiresInSeconds: number,
  date: Date
): PresignedRequest {
  return presign({
    host: r2Host(r2.accountId),
    path: r2ObjectPath(r2.bucket, key),
    method: "PUT",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    region: R2_REGION,
    expiresInSeconds,
    date,
  });
}

/**
 * A one-object DELETE, for cleaning up after a probe.
 *
 * Same signature, same narrow scope as the PUT above: this authorizes the named
 * object and nothing else, so it can remove the four bytes a health probe wrote
 * and cannot empty a bucket. It is deliberately not reachable from a browser
 * request — nothing in the upload path deletes, and the presigned URL a creator
 * holds must stay unable to.
 */
export function presignR2Delete(
  r2: R2Credentials,
  key: string,
  expiresInSeconds: number,
  date: Date
): PresignedRequest {
  return presign({
    host: r2Host(r2.accountId),
    path: r2ObjectPath(r2.bucket, key),
    method: "DELETE",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    region: R2_REGION,
    expiresInSeconds,
    date,
  });
}
