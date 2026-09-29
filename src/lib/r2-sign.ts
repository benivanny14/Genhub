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
// TWO SHAPES OF THE SAME ALGORITHM, and the difference is who holds the result.
//
//   * PRESIGNED — the signature travels in the QUERY STRING, because a browser
//     upload has no way to set an Authorization header on an XHR without
//     becoming a cross-origin request with a preflight of its own. AWS calls
//     this "presigning a URL", and it is the only form a browser can use. The
//     browser uses it to PUT one part, or one whole object.
//   * SIGNED — the signature travels in the AUTHORIZATION HEADER and stays on
//     this server. Used for the three operations that BOUND a multipart upload
//     (begin it, complete it, abandon it), which the browser must never be able
//     to make for itself: completion is what turns a list of parts into the
//     object the ingest Worker reads, and a client that could complete its own
//     upload could also complete one over a part list nobody signed.
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
  /**
   * Parameters that select part of an operation, signed WITH the URL.
   *
   * A single-object PUT needs none of these, which is why the first version of
   * this file had no such field. A multipart upload does: `uploadId` names which
   * upload a part belongs to and `partNumber` names which part, and both are part
   * of what the signature authorizes. Left out of the canonical request, R2
   * accepts the URL and then refuses the request — or worse, honours a part
   * number the signer never agreed to. They are sorted into the canonical query
   * string with everything else, because AWS sorts by parameter NAME and a
   * provider that re-sorts its own copy would otherwise compute a different
   * string to sign.
   */
  extraQuery?: Record<string, string>;
}

/** Everything a caller needs to reproduce or assert the signature. */
export interface PresignedRequest {
  url: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Which query parameters are signed, sorted byte-wise by name as the canonical
 * request requires. `X-Amz-Signature` is deliberately absent — a signature
 * cannot sign itself.
 *
 * The five authentication parameters come first in this order for the same
 * reason: an uppercase `X` (0x58) sorts before every lowercase letter, so the
 * extras (a multipart upload's `partNumber` and `uploadId`) always follow them
 * and the sort is over the whole set rather than over two halves.
 */
function authQuery(params: PresignParams, scope: string, amzDate: string) {
  const auth: [string, string][] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${params.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(params.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const extras = Object.entries(params.extraQuery ?? {});

  return [...auth, ...extras].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
 * A presigned GET of one object, for the one caller that reads the bytes back:
 * the ingest, which moves a finished upload into Bunny and therefore has to be
 * able to ask for a SLICE of it.
 *
 * The Range header is deliberately not signed. S3's rule is that the signature
 * covers the headers it names and nothing else, so a byte range can be chosen at
 * the moment of the read — which is what lets one signed URL fetch an 8 MiB part
 * at a time instead of pulling a two-gigabyte object into a function's memory to
 * hand it on.
 */
export function presignR2Get(
  r2: R2Credentials,
  key: string,
  expiresInSeconds: number,
  date: Date
): PresignedRequest {
  return presign({
    host: r2Host(r2.accountId),
    path: r2ObjectPath(r2.bucket, key),
    method: "GET",
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    region: R2_REGION,
    expiresInSeconds,
    date,
  });
}

/**
 * The sentence R2 puts inside the XML body it refuses with.
 *
 * Worth having shared rather than written twice: R2 says exactly what is wrong
 * and names the field — `<Message>Credential access key has length 31, should be
 * 32</Message>` is the whole diagnosis — and without it a caller reports a bare
 * 403, which is the same answer a revoked key, a wrong bucket and a blocked
 * network all give.
 */
export function r2XmlMessage(body: string): string {
  const message = body.match(/<Message>([^<]{3,140})<\/Message>/)?.[1];
  return message ? ` — ${message}` : "";
}

/**
 * A refusal from the bucket, carrying what it said rather than only that it said
 * no.
 *
 * Named so a route can tell "the bucket refused this" (502, and the creator
 * should not retry unchanged) apart from its own mistakes (throw something
 * else).
 */
export class StorageError extends Error {
  status?: number;
  providerBody?: string;

  constructor(message: string, status?: number, providerBody?: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.providerBody = providerBody?.slice(0, 400);
  }
}

// =============================================================================
// Multipart: the same signing, for a file that has to arrive in pieces
// =============================================================================

/**
 * A part's presigned PUT.
 *
 * `uploadId` and `partNumber` are signed rather than merely appended, so the URL
 * authorizes exactly one part of exactly one upload — and a URL minted for part
 * 3 cannot be replayed as part 4, which is the property that makes a part
 * retried independently of the parts that already succeeded.
 */
export function presignR2UploadPart(
  r2: R2Credentials,
  key: string,
  uploadId: string,
  partNumber: number,
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
    extraQuery: { partNumber: String(partNumber), uploadId },
  });
}

/**
 * A request this process sends itself, authorized by a HEADER.
 *
 * Presigning puts the signature in the query string because a browser cannot set
 * an Authorization header on a cross-origin upload without a preflight. A server
 * has no such limitation, and the three operations that BOUND a multipart upload
 * — begin it, finish it, abandon it — are ours to make: the browser must never be
 * able to declare an upload complete, because completion is what turns a number
 * of parts into an object the ingest Worker will read.
 *
 * The body IS hashed here, unlike a presigned URL. There is a body at signing
 * time, `CompleteMultipartUpload` refuses a request whose part list was not
 * covered by the signature, and `UNSIGNED-PAYLOAD` would let a man in the middle
 * swap the list of parts that make up the creator's video.
 */
export function signR2Request(params: {
  r2: R2Credentials;
  method: string;
  /** The object key, or null for a request that names no object. */
  key: string | null;
  /** Operation parameters: `{ uploads: "" }` to begin, `{ uploadId }` to finish. */
  query?: Record<string, string>;
  /** The exact bytes that will be sent. Omitted means an empty body. */
  body?: string | Buffer;
  date: Date;
}): { url: string; headers: Record<string, string> } {
  const { r2, method } = params;
  const body = params.body ?? "";
  const payloadHash = sha256Hex(body);

  const host = r2Host(r2.accountId);
  const amzDate = amzDateFrom(params.date);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${R2_REGION}/s3/aws4_request`;
  const path = params.key === null ? `/${r2.bucket}` : r2ObjectPath(r2.bucket, params.key);

  const canonicalQueryString = Object.entries(params.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join("&");

  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(path, false),
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey: Buffer | string = `AWS4${r2.secretAccessKey}`;
  for (const part of [dateStamp, R2_REGION, "s3", "aws4_request"]) {
    signingKey = hmac(signingKey, part);
  }
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: `https://${host}${uriEncode(path, false)}` +
      (canonicalQueryString ? `?${canonicalQueryString}` : ""),
    headers: {
      Authorization:
        `${ALGORITHM} Credential=${r2.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
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
