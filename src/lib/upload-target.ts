// =============================================================================
// GENHUB - Where a creator's file goes, and how the bucket is told to accept it
//
// Three halves of one decision, kept in one file because they have to agree: the
// object key a file is uploaded to is the object key Bunny is handed later, and
// splitting that across two modules is how a fetch ends up asking for a key
// nobody wrote.
//
//   1. createPresignedUploadTarget() — ONE PUT, for a file small enough to send
//      in one request. A teaser clip, an intro, a thumbnail-sized video.
//   2. beginMultipartUpload() / signPartUpload() / completeMultipartUpload() —
//      the same object, sent as ~8 MiB parts, for everything else.
//   3. videoObjectKey() — the same key, which is what the ingest step is told to
//      move into the reserved Bunny slot (lib/services/video-ingest.service.ts).
//
// WHY THERE ARE NOW TWO WAYS TO SEND ONE FILE. There was one, and it was the
// single PUT, and it could not work: measured on this application's own failure
// records, a 192 MB file over a 1.55 Mbps link needs seventeen minutes, the
// connection was cut after thirty to sixty seconds, and a transfer with no offset
// to resume from loses everything it sent. The creator saw a bar freeze at the
// percentage their browser had BUFFERED and then "the connection dropped", three
// times, for a file that was never going to arrive. Parts give a reset a price of
// one part instead of the whole file, and the progress figure becomes true
// because a completed part is bytes the bucket has acknowledged.
//
// The single PUT is kept for the small files, where it is simpler and fewer
// requests, and because it is already proven. What bounds it is the part size,
// not the file: anything that fits in one part is one request.
//
// WHY THE KEY IS DERIVED, NOT ACCEPTED. It is built from the video id this
// server just reserved, so no part of it comes from the client. A key the client
// could choose is a key the client could point at another creator's object, and
// the ingest step would then copy somebody else's video into their own post.
//
// THERE IS NO SIZE CEILING HERE. S3 and R2 accept a single PUT up to 5 GiB and a
// multipart upload far beyond it, and Genhub's own video limit is 2 GiB, so every
// file this application accepts fits either way.
// =============================================================================

import config from "./config";
import type { BunnyVideoSlot } from "./bunny";
import {
  isR2Configured,
  presignR2Put,
  presignR2UploadPart,
  r2XmlMessage,
  signR2Request,
  StorageError,
  type R2Credentials,
} from "./r2-sign";

/** The prefix every uploaded object shares, so the bucket can be swept by age. */
const UPLOAD_PREFIX = "incoming";

/**
 * How big one part is.
 *
 * 8 MiB is a compromise with a reason on each side. S3 requires every part but
 * the last to be at least 5 MiB, so this clears the floor; and the cost of a
 * part is one request per part, so a smaller part means more requests to a
 * server that has to sign each one. Eight megabytes is also about a minute on
 * the connection this was designed against (1.55 Mbps), which is a rung of the
 * retry ladder a creator will actually wait out.
 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * How long a part's URL is good for (seconds).
 *
 * Much shorter than a whole-object URL, and deliberately: a part is 8 MiB, which
 * even on a bad link is under a minute, so an hour is generous enough to survive
 * a creator switching apps and back. A URL lifted out of a log is worthless
 * sooner, and the page asks for a fresh one per attempt anyway.
 */
const PART_TTL_SECONDS = 60 * 60;

/** How long this server waits on R2 for the operations it makes itself. */
const R2_CONTROL_TIMEOUT_MS = 20_000;

/**
 * The shape an upload id from the storage service is allowed to have.
 *
 * MEASURED, NOT GUESSED, and the measurement is the point: R2 answered a BEGIN
 * on 2026-09-29 with an id of **343 characters** of base64url. The first version
 * of this rule capped it at 300 — a number invented for looking tidy — so every
 * part request, on every file, was refused by our own validation with HTTP 422
 * "That is not a valid upload id", in 400 milliseconds, before R2 was reached at
 * all. Two creators' uploads were recorded that way, on 3G, after they had spent
 * the time to pick a 192 MB file. A bound that sits near the value it is meant
 * to bound is not a round number, it is a landmine.
 *
 * WHAT THE CEILING IS ACTUALLY FOR. Bounding an input, and nothing else: the
 * character class is the real guard. It keeps the base64 alphabet whole — `/`
 * and `+` included, because base64 uses them and refusing a character the
 * service is allowed to issue is the same mistake in the other direction — and
 * refuses only what could ADD OR CHANGE the operation parameters the signature
 * covers: `?`, `&`, `=`, `#`, `%`, space and newline (lib/r2-sign.ts puts the id
 * in the query string). The length is deliberately far above anything the
 * service issues, because being wrong about it is what broke every upload, while
 * being generous costs nothing: the request body is already capped by the
 * platform, and the id only ever lands in a query string.
 *
 * It lives HERE, in one place, so the three routes that check it cannot drift.
 * They did drift from reality together, which is why one fix repairs all three.
 */
export const MULTIPART_UPLOAD_ID_RE = /^[A-Za-z0-9+/=_-]{1,1024}$/;

/** Whether this is a shape the storage service could have issued. */
export function isMultipartUploadId(value: string): boolean {
  return MULTIPART_UPLOAD_ID_RE.test(value);
}

/**
 * Where one video's file lives in the bucket.
 *
 * Derived from the video id alone: it is a value the server chose, it is unique
 * per upload, and two callers asking for the same video's key always get the
 * same answer.
 */
export function videoObjectKey(videoId: string): string {
  return `${UPLOAD_PREFIX}/${videoId}`;
}

export interface PresignedUpload {
  /** PUT the file here, exactly as it is. */
  url: string;
  /** The object the URL writes. Also what Bunny will be asked to read. */
  key: string;
  /** Unix seconds. After this the URL is refused by R2, not by us. */
  expiresAt: number;
}

/**
 * An upload the bucket has agreed to receive in parts.
 *
 * The `uploadId` is R2's, not ours: it names one multipart upload of one object,
 * and every part URL is signed for it, so a URL minted for this upload cannot be
 * pointed at another. It is also what makes a part retryable on its own — the
 * parts that already succeeded are kept by R2 under this id, which is the whole
 * reason this exists.
 */
export interface MultipartPlan {
  uploadId: string;
  key: string;
  partSizeBytes: number;
  partCount: number;
}

/** One part, as R2 needs it back at completion: the number and the ETag. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * What the upload route answers with, and what the page hands around.
 *
 * `presigned` and `multipart` are mutually exclusive by construction: the server
 * looks at the size the client reported and prepares ONE of them, so the page
 * never has to decide which transport is correct and cannot pick the one the
 * server did not sign for.
 */
export interface UploadTarget extends BunnyVideoSlot {
  /** One request for the whole object; null when the file has to arrive in parts. */
  presigned: PresignedUpload | null;
  /** Set when the file is bigger than a single part; null otherwise. */
  multipart: MultipartPlan | null;
}

/**
 * Whether this deployment can hand out a presigned upload.
 *
 * Both halves are required: without R2 there is nothing to sign for, and without
 * the reader Bunny would be given a URL it cannot authorize. A half-configured
 * pair is reported by productionConfigWarnings() rather than discovered as a
 * failed upload.
 */
export function isPresignedUploadConfigured(): boolean {
  return (
    isR2Configured(config.r2) &&
    Boolean(config.videoIngest.url && config.videoIngest.secret)
  );
}

/** How many parts a file of this size takes. Zero for an empty file. */
export function partCountFor(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return 0;
  return Math.ceil(fileSize / UPLOAD_PART_BYTES);
}

/**
 * Whether this file has to arrive in parts.
 *
 * One part is not multipart: a single part would be a single PUT with three extra
 * requests around it, so the small files keep the simpler transport.
 */
export function needsMultipart(fileSize: number): boolean {
  return partCountFor(fileSize) > 1;
}

/**
 * The target the browser uploads to, or null when this deployment has no bucket
 * configured — in which case the caller refuses the upload rather than sending
 * anyone to a URL that cannot work. There is no second transport to fall back to.
 */
export function createPresignedUploadTarget(
  videoId: string,
  now: Date = new Date()
): PresignedUpload | null {
  if (!isR2Configured(config.r2)) return null;

  const key = videoObjectKey(videoId);
  const expiresInSeconds = Math.max(60, config.r2.uploadUrlTtlSeconds);
  const { url } = presignR2Put(config.r2, key, expiresInSeconds, now);

  return {
    url,
    key,
    expiresAt: Math.floor(now.getTime() / 1000) + expiresInSeconds,
  };
}

/**
 * Ask the bucket to receive this object in parts, and remember the id it answers
 * with.
 *
 * Made HERE, by this server, and not presigned for the browser: beginning an
 * upload costs an incomplete-multipart entry in the bucket, and a client that
 * could begin uploads at will could leave them behind. It also keeps the part
 * count honest — the size comes from the same request that reserved the slot.
 *
 * The id comes back inside XML, which is the one place S3 will put it. Failing to
 * find it is its own error rather than a crash on `undefined` later, because a
 * plan without an upload id is a plan every part would fail against.
 */
export async function beginMultipartUpload(
  videoId: string,
  fileSize: number,
  now: Date = new Date()
): Promise<MultipartPlan> {
  if (!isR2Configured(config.r2)) {
    throw new StorageError("The upload storage is not configured");
  }

  const key = videoObjectKey(videoId);
  const started = signR2Request({
    r2: config.r2,
    method: "POST",
    key,
    query: { uploads: "" },
    date: now,
  });

  const response = await fetch(started.url, {
    method: "POST",
    headers: started.headers,
    cache: "no-store",
    signal: AbortSignal.timeout(R2_CONTROL_TIMEOUT_MS),
  });
  const body = await response.text().catch(() => "");

  if (!response.ok) {
    throw new StorageError(
      `The storage service refused to begin the upload (HTTP ${response.status}${r2XmlMessage(body)})`,
      response.status,
      body
    );
  }

  const uploadId = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) {
    throw new StorageError(
      "The storage service began the upload without naming it, so no part could be signed",
      response.status,
      body
    );
  }

  return {
    uploadId,
    key,
    partSizeBytes: UPLOAD_PART_BYTES,
    partCount: partCountFor(fileSize),
  };
}

/**
 * A fresh URL for one part, signed now.
 *
 * Signed per part rather than handed out as a list at the start: a URL minted for
 * part 3 cannot be replayed as part 4 (it is covered by the signature), and a
 * part that is retried twenty minutes after the upload began needs a deadline
 * that has not passed.
 */
export function signPartUpload(
  videoId: string,
  uploadId: string,
  partNumber: number,
  now: Date = new Date()
): PresignedUpload {
  const key = videoObjectKey(videoId);
  const { url } = presignR2UploadPart(
    config.r2 as R2Credentials,
    key,
    uploadId,
    partNumber,
    PART_TTL_SECONDS,
    now
  );

  return { url, key, expiresAt: Math.floor(now.getTime() / 1000) + PART_TTL_SECONDS };
}

/** The XML that names which parts make up the object, in order. */
export function completeMultipartBody(parts: CompletedPart[]): string {
  return (
    "<CompleteMultipartUpload>" +
    parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`
      )
      .join("") +
    "</CompleteMultipartUpload>"
  );
}

/**
 * Tell the bucket the parts are all there, which is what makes the object exist.
 *
 * The body is signed, not the URL, and that is the point: `CompleteMultipartUpload`
 * is the request that decides WHICH bytes become the creator's video, and a
 * signature that did not cover the part list would let the list be swapped
 * between signing and sending.
 */
export async function completeMultipartUpload(
  videoId: string,
  uploadId: string,
  parts: CompletedPart[],
  now: Date = new Date()
): Promise<void> {
  const key = videoObjectKey(videoId);
  const body = completeMultipartBody(parts);
  const signed = signR2Request({
    r2: config.r2,
    method: "POST",
    key,
    query: { uploadId },
    body,
    date: now,
  });

  const response = await fetch(signed.url, {
    method: "POST",
    headers: { ...signed.headers, "Content-Type": "application/xml" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(R2_CONTROL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const refusal = await response.text().catch(() => "");
    throw new StorageError(
      `The storage service would not finish the upload (HTTP ${response.status}${r2XmlMessage(refusal)})`,
      response.status,
      refusal
    );
  }

  // A complete that answers 200 with an <Error> inside is S3's other way of
  // refusing, and it is used for exactly the interesting case: a part list that
  // does not add up. Read as success, that is an object nobody ever gets.
  const answer = await response.text().catch(() => "");
  const embedded = r2XmlMessage(answer);
  if (embedded) {
    throw new StorageError(
      `The storage service would not finish the upload${embedded}`,
      response.status,
      answer
    );
  }
}

/**
 * Give up on an upload, so its parts stop being stored and billed.
 *
 * Best effort by design: the caller is already handling a failure, and a bucket
 * that will not let go of an abandoned upload must not turn one failure into
 * two. Returns whether the bucket acknowledged it.
 */
export async function abortMultipartUpload(
  videoId: string,
  uploadId: string,
  now: Date = new Date()
): Promise<boolean> {
  if (!isR2Configured(config.r2)) return false;

  try {
    const signed = signR2Request({
      r2: config.r2,
      method: "DELETE",
      key: videoObjectKey(videoId),
      query: { uploadId },
      date: now,
    });
    const response = await fetch(signed.url, {
      method: "DELETE",
      headers: signed.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(R2_CONTROL_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
