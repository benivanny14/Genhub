// =============================================================================
// GENHUB - Getting a finished upload out of the bucket and into Bunny
//
// The upload's last step, from the page's side. The bytes are already in the
// bucket (lib/upload-send.ts), Bunny reserves the slot, and something has to put
// the two together — that something is /api/videos/ingest, and it is a
// PROVIDER-TO-PROVIDER move: the creator's data plan is not spent on it.
//
// WHY THIS IS A LOOP AND NOT ONE REQUEST. A serverless invocation has a
// wall-clock budget, and a two-gigabyte file crossing between two providers can
// outlast it on a bad day — so a route that tried to carry the whole thing in
// one request would have to either lie about finishing or be killed before it
// could say anything. The route therefore moves what it can, answers with how
// far it got, and is asked again; each round picks up from the offset BUNNY
// reports, so nothing already sent is ever sent twice.
//
// WHY A FAILURE HERE IS AN UPLOAD FAILURE. The bucket holding the file is not
// the same as Bunny holding it, and only the second one makes a post — a video
// that is only in the bucket plays nowhere. So this throws the same
// VideoUploadError every other upload failure uses, and the page's existing
// machinery (a message, a Retry that keeps the reserved slot) applies unchanged.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not retry a refusal: a 503 with no
// library key, a 409 with no object, a 502 from Bunny are all answers that will
// be the same a second later. It does wait out a slow transfer, because that is
// what the loop is for — and it gives up eventually, with a sentence that says
// the file will not be sent again.
// =============================================================================

import { VideoUploadError } from "./upload-error";

/** How long between polls. Short, because a poll that finds nothing costs a
 *  server-side HEAD and the creator is watching a bar. */
export const PREPARE_POLL_MS = 1_500;

/**
 * How long the page keeps asking before it hands the decision to the creator.
 *
 * Both providers are moving the same file here and neither is the creator's
 * phone, so this is a server-side speed question: half an hour is far past
 * anything healthy, and a creator who has waited that long is better served by a
 * message than by a bar that keeps saying nothing.
 */
export const PREPARE_MAX_MS = 30 * 60 * 1000;

export interface PrepareOptions {
  /** Bytes Bunny holds, out of the file's size. Called on every poll. */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortError(): VideoUploadError {
  return new VideoUploadError("ABORTED", "Upload cancelled", undefined, {
    stage: "chunk",
    reason: "cancelled",
  });
}

/**
 * Ask until Bunny holds the whole file, or fail with a sentence worth reading.
 *
 * Resolves when the video is in front of the encoder. Throws VideoUploadError,
 * carrying the route's own message rather than one invented here: the route
 * knows which of the reasons it is (`describeIngestFailure`), and a second copy
 * of that wording is how two screens start telling two stories about one fault.
 */
export async function prepareVideoWithBunny(
  videoId: string,
  options: PrepareOptions = {}
): Promise<void> {
  const { onProgress, signal } = options;
  const startedAt = Date.now();
  let uploaded = 0;
  let total = 0;

  for (;;) {
    if (signal?.aborted) throw abortError();

    let res: Response;
    try {
      res = await fetch("/api/videos/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      // The request to our OWN server never produced an answer, so this is the
      // connection and not the size of anything. Said that way because the file
      // is already uploaded: a creator told "upload failed" here would send a
      // gigabyte again for a move that costs them nothing.
      throw new VideoUploadError(
        "NETWORK",
        "The upload finished, but the video could not be prepared — the connection dropped. Press retry: it will not send the file again.",
        undefined,
        { stage: "chunk", reason: "reset" }
      );
    }

    const data = (await res.json().catch(() => null)) as
      | {
          success?: boolean;
          error?: string;
          code?: string;
          data?: { ready?: boolean; uploadedBytes?: number; totalBytes?: number };
        }
      | null;

    if (!res.ok || !data?.success) {
      throw new VideoUploadError(
        res.status === 401 || res.status === 403 ? "REJECTED" : "NETWORK",
        data?.error || "The video could not be prepared after uploading. Please try again.",
        res.status,
        { stage: "chunk", reason: "provider" }
      );
    }

    if (data.data?.ready) {
      onProgress?.(total || uploaded, total || uploaded);
      return;
    }

    if (typeof data.data?.totalBytes === "number" && data.data.totalBytes > 0) {
      total = data.data.totalBytes;
    }
    if (typeof data.data?.uploadedBytes === "number") {
      uploaded = data.data.uploadedBytes;
    }
    onProgress?.(uploaded, total);

    if (Date.now() - startedAt > PREPARE_MAX_MS) {
      throw new VideoUploadError(
        "NETWORK",
        "The video took too long to be prepared. Press retry: it will not send the file again.",
        undefined,
        { stage: "chunk", reason: "stall" }
      );
    }

    await sleep(PREPARE_POLL_MS, signal);
  }
}
