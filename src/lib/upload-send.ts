// =============================================================================
// GENHUB - Getting one file into the bucket, by whichever route was signed for
//
// The server decides the transport, not the page. `upload-signature` looks at
// the size the picker reported and prepares EXACTLY ONE of two things: a
// presigned URL for one whole PUT, or a multipart plan (see
// lib/upload-target.ts). This file is the client half of that decision — it
// sends the file down the road the server already opened, and it is one function
// rather than a branch in each of the three call sites (the upload form's main
// video, its teaser, and the creator dashboard's trailer) because three copies
// of "which transport is this" is three chances for one of them to be wrong.
//
// WHY THE MULTIPART BRANCH ALSO COMPLETES. A part is stored under an upload id,
// and until `CompleteMultipartUpload` names the parts, the object does not exist
// — Bunny would be handed a key with nothing behind it and the creator would see
// a video that uploaded and then never played. So the two are one operation from
// the caller's point of view, and the failure of either is an upload failure.
//
// The complete request is made by the SERVER, not signed for the browser: it is
// the request that decides which bytes become the creator's video, and its body
// (the part list) is what the server checks before the bucket sees it.
// =============================================================================

import { VideoUploadError, type UploadRetryInfo } from "./upload-error";
import {
  abandonMultipartUpload,
  forgetMultipartResume,
  signalWithTimeout,
  uploadFileInParts,
} from "./upload-multipart";
import { uploadFileWithPut } from "./upload-put";
import type { CompletedPart, UploadTarget } from "./upload-target";

/** How long the request that assembles the parts may take before giving up. */
const COMPLETE_TIMEOUT_MS = 60_000;

export interface SendFileOptions {
  /** Bytes the bucket has acknowledged, out of the file's size. */
  onProgress?: (uploaded: number, total: number) => void;
  /** Before a retry, so the screen can say why it is waiting. */
  onRetry?: (info: UploadRetryInfo) => void;
  /** How many parts an earlier run already delivered, once, at the start. */
  onResume?: (partsAlreadySent: number) => void;
  signal?: AbortSignal;
}

/**
 * Tell the server to turn the uploaded parts into the object.
 *
 * Kept separate from `uploadFileInParts` because it is a different request with a
 * different failure: every other part of this transport is reversible (a part
 * that did not arrive is a part to send again), while this one either makes the
 * video or does not.
 */
async function completeUpload(
  videoId: string,
  uploadId: string,
  parts: CompletedPart[],
  signal?: AbortSignal
): Promise<void> {
  const deadline = signalWithTimeout(signal, COMPLETE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("/api/videos/upload-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, uploadId, parts }),
      signal: deadline.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && signal?.aborted) {
      throw new VideoUploadError("ABORTED", "Upload cancelled", undefined, {
        stage: "chunk",
        reason: "cancelled",
      });
    }
    // The parts are all in the bucket, so nothing is lost — a retry re-sends
    // none of the file and comes straight back to this request. Said that way,
    // because a creator told only "the connection dropped" would send two
    // gigabytes again for a failure that costs them a few hundred kilobytes.
    throw new VideoUploadError(
      "NETWORK",
      "Every part of the video is uploaded, but the upload could not be finished. Press retry — it will not send the file again.",
      undefined,
      { stage: "chunk", reason: "reset" }
    );
  } finally {
    deadline.release();
  }

  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: string; code?: string }
    | null;

  if (!res.ok || !data?.success) {
    throw new VideoUploadError(
      res.status === 401 || res.status === 403 ? "REJECTED" : "NETWORK",
      data?.error || "The video could not be finished after uploading. Please upload it again.",
      res.status,
      { stage: "chunk", reason: "provider" }
    );
  }
}

/**
 * The multipart upload this page is holding, if any.
 *
 * Kept so a creator leaving the page can be told to give it up: an unfinished
 * multipart upload is real, billed storage in the bucket holding every part that
 * was sent, and nothing about it expires usefully on its own (see
 * api/videos/upload-abort). It stays registered after a FAILURE as well as
 * during a transfer, because the retry it exists for needs the parts that are
 * already there — but the moment the page is gone, no retry can reach them.
 */
let pending: { videoId: string; uploadId: string } | null = null;

/**
 * Give up whatever this page was holding, when the creator navigates away.
 *
 * Never called for a failure: a failed attempt keeps its slot and its parts so
 * Retry costs one part instead of the whole file, and abandoning them is the
 * exact opposite of what the creator wants next. Called on unmount only, where
 * there is no next.
 */
export function abandonPendingUpload(): void {
  const upload = pending;
  pending = null;
  if (upload) abandonMultipartUpload(upload.videoId, upload.uploadId);
}

/**
 * Send `file` to the target the server prepared, and resolve once the bucket
 * holds it — complete, as one object.
 *
 * Throws VideoUploadError with the same vocabulary every other upload failure
 * uses, so a multipart failure still leaves a record an operator can read
 * (lib/services/upload-failure.service.ts): which part died, from which offset,
 * and how long each attempt at it lasted.
 */
export async function sendFileToTarget(
  file: File,
  target: UploadTarget,
  options: SendFileOptions = {}
): Promise<void> {
  const { videoId } = target;

  if (target.multipart) {
    const { uploadId } = target.multipart;
    pending = { videoId, uploadId };

    const { parts } = await uploadFileInParts(
      file,
      { videoId, ...target.multipart },
      options
    );

    // A 409 from this request is the one answer a retry cannot improve: the list
    // of parts this browser recorded does not match what the bucket holds, so
    // replaying it says the same thing. Clearing the record makes the retry
    // START OVER into the same upload id instead of failing identically — the
    // bucket overwrites a part number it already has, so re-sending is safe and
    // is the only way back from here.
    try {
      await completeUpload(videoId, uploadId, parts, options.signal);
    } catch (error) {
      if (error instanceof VideoUploadError && error.status === 409) {
        forgetMultipartResume(file);
      }
      throw error;
    }

    // Done: nothing to resume into, and nothing left to abandon.
    forgetMultipartResume(file);
    pending = null;
    return;
  }

  if (!target.presigned) {
    // The server prepared neither transport, which is a deployment that changed
    // its mind between two calls. Refused rather than guessed at, because the
    // alternative is sending a whole file to a URL that was never signed.
    throw new VideoUploadError(
      "REJECTED",
      "The upload was not prepared. Please press retry.",
      undefined,
      { stage: "reserve", reason: "provider" }
    );
  }

  await uploadFileWithPut(file, target.presigned, options);
}
