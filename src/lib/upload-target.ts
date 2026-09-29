// =============================================================================
// GENHUB - Where a creator's file goes, and how Bunny is told to come and get it
//
// Two halves of one decision, kept in one file because they have to agree: the
// object key a file is uploaded to is the object key Bunny is handed later, and
// splitting that across two modules is how a fetch ends up asking for a key
// nobody wrote.
//
//   1. createPresignedUploadTarget() — the URL the browser PUTs to. Signed for
//      one object, one method, one deadline (lib/r2-sign.ts). No credential
//      leaves this server.
//   2. videoObjectKey() — the same key, which is what the ingest step is told to
//      move into the reserved Bunny slot (lib/services/video-ingest.service.ts).
//
// The slot itself is reserved first, by the Bunny key (lib/bunny.ts); these two
// functions assume that has already happened and only ever name its object.
//
// WHY THE KEY IS DERIVED, NOT ACCEPTED. It is built from the video id this
// server just reserved, so no part of it comes from the client. A key the client
// could choose is a key the client could point at another creator's object, and
// the ingest step would then copy somebody else's video into their own post.
//
// THERE IS NO SIZE CEILING HERE. S3 and R2 accept a single PUT up to 5 GiB, and
// Genhub's own video limit is 2 GiB, so every file this application accepts fits
// in one request — which is the property that made a whole second transport
// unnecessary. A proxy would have had to receive the file, and Cloudflare's
// per-plan request-body limit (100 MB on Free and Pro) is what used to cap the
// one-shot path; a presigned URL is not a proxy, so there is nothing to cap.
// =============================================================================

import config from "./config";
import type { BunnyVideoSlot } from "./bunny";
import { isR2Configured, presignR2Put } from "./r2-sign";

/** The prefix every uploaded object shares, so the bucket can be swept by age. */
const UPLOAD_PREFIX = "incoming";

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

/**
 * What the upload route answers with, and what the page hands around.
 *
 * One transport, so `presigned` is not optional: a reservation that produced no
 * URL is a deployment with no bucket configured, and that is answered with a
 * refusal rather than with a credential the client has no way to use.
 */
export interface UploadTarget extends BunnyVideoSlot {
  presigned: PresignedUpload;
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

