// =============================================================================
// GENHUB - Move a finished upload out of the bucket and into Bunny
//
// The upload ends in R2, not in Bunny, so something has to close the gap before
// the encode lifecycle has anything to watch. This is that step, and it is a
// separate call from the request that creates the post on purpose: a video is
// tens of megabytes moving between two providers, and folding that into the
// request that writes the row would make the creator's "publish" as long as the
// slowest network hop in the pipeline — and would leave a half-written post
// behind when it timed out.
//
// WHY NOT BUNNY'S OWN FETCH API. It is the obvious tool and it does not fit:
// `POST /library/{id}/videos/fetch` creates a video object of its own and its
// documented (and observed) response carries no guid —
//
//     { "success": true, "message": "OK", "statusCode": 200 }
//
// — so it cannot fill the slot that was reserved for this creator's post, and a
// RETRY creates a second video with a second guid holding the same bytes. Every
// other part of Genhub is keyed on the Bunny guid, so a guid that has to be
// hunted for after the fact is a guid that can be attached to the wrong post.
//
// WHY THIS RUNS HERE AND NOT ONLY IN A WORKER. It used to be worker/video-ingest
// alone, and that is how a completed upload came to fail at 100% on 2026-09-29:
// the Worker deployed in production was the version that pushes the whole object
// through one subrequest, Cloudflare caps a subrequest body at 100 MB, and the
// creator's 192 MB file — already sitting in the bucket, already paid for —
// ended at an HTML "Worker threw exception" page. Nothing in the app could see
// it: the transfer step reported success, the ingest step had no record, and the
// fix for it was committed but needed a manual `wrangler deploy` that had not
// happened. A step that only works after somebody remembers a separate deploy is
// not a step; it is a trap. So the move is made by this application's own server
// now, deployed with the application, and the Worker is kept only as an
// alternative (see worker/video-ingest/README.md).
//
// WHY IT IS CHUNKED AND RESUMABLE, given that this server could stream the whole
// object in one request. Two reasons, and neither is about the platform's
// patience:
//
//   * A serverless function has a wall-clock budget (60s here, see the route's
//     maxDuration). One request cannot carry a 2 GB file inside that on a bad
//     day, and a step that works for a 190 MB video and dies for a 1 GB one is
//     a step that fails exactly the creators who spent the most data.
//   * Bunny's resumable endpoint remembers its own offset, so a transfer cut
//     anywhere continues from where it stopped instead of starting again. The
//     offset is asked of BUNNY, never of anything this app stored, and the one
//     thing stored is the upload's URL (48h, in Redis) because Bunny's protocol
//     identifies a transfer by it.
//
// So one call reads what is missing from the bucket in 32 MB slices and PATCHes
// each one into the reserved video until either Bunny holds the whole file or
// this call is nearly out of time. A call that runs out answers `pending` with
// how far it got, and the page asks again — which is why a large ingest is many
// short requests rather than one request nobody can see into.
//
// WHAT A FAILURE MEANS. Every outcome below is decided by something an operator
// can act on: the bucket or the library being unconfigured, Bunny refusing the
// file or the key, the object never having arrived, or the transfer being
// unreachable. None of them are reported as "connection dropped", which is the
// sentence this whole thread of work exists to stop saying wrongly.
// =============================================================================

import config from "@/lib/config";
import { videoObjectKey } from "@/lib/upload-target";
import {
  isR2Configured,
  presignR2Get,
  r2XmlMessage,
  signR2Request,
  type R2Credentials,
} from "@/lib/r2-sign";
import { cacheDel, cacheGet, cacheSet } from "@/lib/redis";
import { getBunnyVideoDetails } from "@/lib/bunny";
import { TRANSIENT_4XX } from "@/lib/upload-error";
import {
  createTusUpload,
  patchTusChunk,
  tusAuthHeaders,
  tusUploadOffset,
  TUS_AUTH_TTL_SECONDS,
} from "@/lib/bunny-tus";

/**
 * How long ONE CALL may spend moving bytes.
 *
 * This is the caller's patience for a single request, not the transfer's limit:
 * an ingest that outlives it answers `pending` and is continued by the next
 * call, with Bunny holding everything already sent.
 *
 * IT MUST STAY UNDER THE ROUTE'S OWN BUDGET. `/api/videos/ingest` declares
 * `maxDuration = 60`, and an earlier version of this step gave a single fetch as
 * long as the route itself — so the abort and the function's kill landed on the
 * same instant, the request died with no body, and the page could only say
 * "Network error while preparing the video": the one message that names no
 * cause, on the one step where the cause is knowable. The headroom below is what
 * lets the answer be written before the function is taken away.
 *
 * MEASURED, THEN SHORTENED. The first live run of this transfer — a real
 * 201,291,964-byte object, in slices of 32 MB — answered at 46.8 seconds against
 * a 40-second budget, because the budget is checked BETWEEN slices and a slice
 * that is already running is allowed to finish. That is inside the route's 60
 * seconds, but only just, and a platform kill is the one ending this file exists
 * to avoid. Thirty seconds keeps a call near 35 even when every slice runs long,
 * at the cost of a few more calls for a large file — and a call is cheap: it
 * moves no bytes until it has asked Bunny where the transfer already is.
 *
 * Exported so the relationship is asserted rather than remembered — see
 * tests/video-ingest.test.ts.
 */
export const INGEST_BUDGET_MS = 30_000;

/**
 * How much of the file one request carries.
 *
 * A slice is buffered in memory, so this bounds the function's peak usage; and
 * it is the unit a retry re-sends, so it also bounds what a reset costs. 32 MB
 * is a compromise between the two: a 2 GB video is 64 requests rather than
 * thousands, and one failed slice is 32 MB of provider-to-provider traffic
 * rather than a transfer nobody wants to repeat.
 */
export const INGEST_CHUNK_BYTES = 32 * 1024 * 1024;

/** How long one slice may take before the connection to Bunny is called dead. */
const CHUNK_TIMEOUT_MS = 20_000;

/** How long the small control requests (a HEAD of the bucket, a HEAD of Bunny)
 *  may take. They move no bytes, so a slow one is a fault, not a big file. */
const CONTROL_TIMEOUT_MS = 15_000;

/** A wait that a signal cannot cancel: this runs on the server, where the only
 *  thing above it is the platform's own clock. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The last few seconds of a call belong to the answer, not to a slice.
 *
 * A slice started with two seconds left would be aborted by the platform rather
 * than reported, which is the one outcome this whole file is written to avoid.
 */
const ANSWER_HEADROOM_MS = 2_500;

/** How long a stored TUS upload URL is kept. Bunny abandons an unfinished
 *  upload after about two days, so there is nothing to reach past that. */
const TUS_URL_TTL_SECONDS = 48 * 60 * 60;

/** How long a presigned read of one slice is good for. It is used immediately. */
const SLICE_URL_TTL_SECONDS = 300;

/**
 * How many times one request is sent before the call gives up and answers
 * `pending`, and how long between tries.
 *
 * MEASURED, NOT CHOSEN. The first live run of this transfer against the real
 * library was answered `423 File is currently being updated. Please try again
 * later` — Bunny's own words, and a status this application already learned to
 * retry on the direct-to-Bunny path (see TRANSIENT_4XX in lib/upload-error.ts,
 * where reading 423 as permanent once ended an upload that was a quarter sent).
 * A transfer that treats "try again later" as "no" throws away a file that is
 * already half across, so the retry is here, and the transient set is IMPORTED
 * rather than copied so the two places cannot drift apart.
 */
const REQUEST_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;

export type IngestFailureReason =
  | "not-configured"
  | "refused"
  | "not-uploaded"
  | "unreachable";

export interface IngestOutcome {
  /** True only once Bunny holds the WHOLE file. */
  ok: boolean;
  /**
   * Set when the transfer is under way and unfinished: not a failure, and the
   * caller should ask again. Kept separate from `ok` because the two callers
   * treat them differently — the page continues, an operator's self-test waits.
   */
  pending?: boolean;
  reason?: IngestFailureReason;
  /** Whatever the far side said, trimmed — for the log and the admin card. */
  detail?: string;
  /** Bytes Bunny holds, once it holds all of them. */
  bytes?: number;
  /** How far a pending transfer has got, and how long the file is. */
  uploadedBytes?: number;
  totalBytes?: number;
}

/** What to tell the creator, in the words they need to act on. */
export function describeIngestFailure(outcome: IngestOutcome): string {
  switch (outcome.reason) {
    case "not-configured":
      // Deliberately not "no bucket": what the ingest actually needs is the
      // bucket AND the library key, and naming only one of them sends whoever
      // reads this looking in the wrong place.
      return "This deployment's upload storage is not configured, so the file cannot be prepared. Tell support.";
    case "not-uploaded":
      return "The upload did not reach storage. Please upload the video again.";
    case "refused":
      return `The video service refused the file (${outcome.detail || "no detail"}). Please try again.`;
    default:
      return "The upload finished but could not be handed to the video service. Please try again.";
  }
}

/** One object's length, from metadata. Reads no bytes. */
async function bucketObjectSize(
  key: string
): Promise<{ found: boolean; size: number; detail?: string }> {
  const signed = signR2Request({
    r2: config.r2,
    method: "HEAD",
    key,
    date: new Date(),
  });

  try {
    const response = await fetch(signed.url, {
      method: "HEAD",
      headers: signed.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });

    if (response.status === 404) return { found: false, size: 0 };
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        found: false,
        size: 0,
        // R2's own words when it has any: a bare 403 is the same answer a
        // revoked key, a wrong bucket and a bad signature all give.
        detail: `HTTP ${response.status}${r2XmlMessage(body)}`,
      };
    }

    const size = Number(response.headers.get("content-length"));
    if (!Number.isFinite(size) || size <= 0) return { found: false, size: 0 };
    return { found: true, size };
  } catch (error) {
    return {
      found: false,
      size: 0,
      detail: `${error instanceof Error ? error.name : "UnknownError"}`,
    };
  }
}

/**
 * One slice of the object, read with a byte range.
 *
 * The URL is signed here and used immediately, so a leaked one is worthless, and
 * the Range header is not part of the signature — see presignR2Get. A slice that
 * cannot be read is null rather than an exception: the caller turns that into
 * "the upload did not reach storage", which is what it is.
 */
async function readBucketSlice(
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array | null> {
  const { url } = presignR2Get(
    config.r2 as R2Credentials,
    key,
    SLICE_URL_TTL_SECONDS,
    new Date()
  );

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS + CHUNK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * How many bytes Bunny already holds for this slot, or null when it holds none.
 *
 * Asked only when the bucket has nothing, and it is what makes this whole step
 * safe to repeat: a call that finished the transfer and then had its answer lost
 * on the way back would otherwise find no object — the copy is deleted on
 * success — and tell the creator to upload two gigabytes again. The file is in
 * the library; that is the fact that matters.
 */
async function bunnyStoredBytes(videoId: string): Promise<number | null> {
  try {
    const details = (await getBunnyVideoDetails(videoId)) as Record<string, unknown>;
    const size = Number(details?.storageSize) || 0;
    const status = Number(details?.status) || 0;

    // THE STATUS IS THE RELIABLE HALF, and the reason is measured: a slot that
    // has received a complete file leaves Bunny's initial Queued(0) within a
    // second of the last byte — this transfer's own live run landed on 2
    // (Processing) — while `storageSize` still read 0 until the encode reported
    // sizes of its own. Judged on `storageSize` alone, a video that WAS delivered
    // looks undelivered, and the creator is told to upload two gigabytes again.
    // Same rule as the admin self-test's read-back (bunnyTookTheFile).
    if (size > 0) return size;
    if (status !== 0) return 0;
    return null;
  } catch {
    // A library that cannot answer is not evidence that it lacks the file.
    return null;
  }
}

/** Where this video's unfinished resumable upload is remembered. */
function tusUrlKey(videoId: string): string {
  return `bunny:tus:${videoId}`;
}

/** The stored upload URL for this slot, if Redis still has one.
 *
 *  Redis being unreachable is a miss, not an error: the worst case is a fresh
 *  TUS upload, which is exactly what happened before this was stored at all. */
async function loadTusUrl(videoId: string): Promise<string | null> {
  const stored = await cacheGet<string>(tusUrlKey(videoId));
  return typeof stored === "string" && stored.startsWith("https://") ? stored : null;
}

/**
 * Hand one uploaded object to Bunny, into the slot reserved for this video id.
 *
 * Returns `ok: true` only once Bunny holds the whole file. A transfer that is
 * still moving when the call's budget ends returns `pending` with its offset, so
 * the caller can ask again and continue rather than start over.
 *
 * `now` is passed in so the budget can be tested without waiting for it, and so
 * a test can hand in a moment in the past to watch a call run out of time.
 */
export async function ingestUploadedVideo(
  videoId: string,
  now: Date = new Date()
): Promise<IngestOutcome> {
  const { libraryId, apiKey } = config.bunny;

  // Both halves are needed and neither is inferred: without the bucket there are
  // no bytes to move, and without the library key there is nowhere to move them.
  if (!isR2Configured(config.r2) || !libraryId || !apiKey) {
    return { ok: false, reason: "not-configured" };
  }

  const key = videoObjectKey(videoId);
  const deadline = now.getTime() + INGEST_BUDGET_MS;

  // 1. How long is the file? From metadata, before a byte of it is read.
  const head = await bucketObjectSize(key);
  if (!head.found) {
    // Either the upload never finished, or this is a repeat of a call that did
    // and whose answer was lost on the way back. Bunny is the one that knows.
    const alreadyThere = await bunnyStoredBytes(videoId);
    if (alreadyThere !== null) return { ok: true, bytes: alreadyThere };
    return {
      ok: false,
      reason: head.detail ? "refused" : "not-uploaded",
      detail: head.detail,
    };
  }

  const total = head.size;
  const auth = await tusAuthHeaders({
    libraryId,
    apiKey,
    videoId,
    // Measured from NOW rather than from the call's start, and generously: the
    // signature is revalidated on every PATCH, so it has to outlast the whole
    // transfer however many calls that takes.
    expiresAt: Math.floor(Date.now() / 1000) + TUS_AUTH_TTL_SECONDS,
  });

  // 2. Continue the upload this slot already has, or open one. Bunny identifies
  //    a resumable transfer by its URL, which is why that is the one thing
  //    remembered between calls.
  let uploadUrl = await loadTusUrl(videoId);

  if (uploadUrl) {
    // A stored URL whose transfer Bunny has forgotten answers zero, and a
    // resource that no longer exists is not worth a second thought: a fresh
    // create is correct, only slower.
    const known = await tusUploadOffset({ uploadUrl, headers: auth, timeoutMs: CONTROL_TIMEOUT_MS });
    if (known <= 0) uploadUrl = null;
  }

  if (!uploadUrl) {
    let lastDetail = "";

    for (let attempt = 0; attempt < REQUEST_ATTEMPTS && !uploadUrl; attempt += 1) {
      if (attempt > 0) {
        if (deadline - Date.now() <= ANSWER_HEADROOM_MS + REQUEST_RETRY_DELAY_MS) break;
        await sleep(REQUEST_RETRY_DELAY_MS);
      }

      const created = await createTusUpload({
        libraryId,
        apiKey,
        videoId,
        total,
        expiresAt: Number(auth.AuthorizationExpire),
        timeoutMs: CONTROL_TIMEOUT_MS,
      });

      if (created.ok) {
        uploadUrl = created.uploadUrl;
        break;
      }

      // A status of 0 is the request never arriving at all, which has no HTTP
      // answer to quote; the transport's own words are kept in `detail`.
      lastDetail =
        created.status === 0
          ? created.detail
          : `HTTP ${created.status} ${created.detail}`.trim();

      // Answered, and repeating it changes nothing — unless Bunny's own words
      // say it will (423/408/409/429, and anything 5xx). A refusal is reported
      // with Bunny's own words instead of spending the call's budget on it.
      if (
        created.status !== 0 &&
        !TRANSIENT_4XX.has(created.status) &&
        created.status < 500
      ) {
        return { ok: false, reason: "refused", detail: lastDetail };
      }
    }

    if (!uploadUrl) {
      // Either the provider kept asking for time or the request never arrived.
      // `pending` rather than a failure: the next call tries again, which is
      // exactly what "please try again later" asks for.
      return { ok: false, pending: true, uploadedBytes: 0, totalBytes: total, detail: lastDetail };
    }

    await cacheSet(tusUrlKey(videoId), uploadUrl, TUS_URL_TTL_SECONDS);
  }

  // 3. Where does Bunny think this transfer is? Asked rather than assumed, so a
  //    call that arrives after another one already finished costs nothing.
  let offset = await tusUploadOffset({ uploadUrl, headers: auth, timeoutMs: CONTROL_TIMEOUT_MS });

  // 4. Send what is missing, one slice at a time.
  while (offset < total) {
    if (Date.now() >= deadline - ANSWER_HEADROOM_MS) {
      return {
        ok: false,
        pending: true,
        uploadedBytes: offset,
        totalBytes: total,
        detail: `${offset} of ${total} bytes are in the library; the rest continues on the next call`,
      };
    }

    const length = Math.min(INGEST_CHUNK_BYTES, total - offset);
    const slice = await readBucketSlice(key, offset, length);
    if (!slice) {
      // The object was there a moment ago, so this is the bucket, not the
      // creator. Reported as such rather than as a failed upload.
      return {
        ok: false,
        reason: "not-uploaded",
        detail: `the object could not be read at offset ${offset}`,
      };
    }

    let advanced: number | null = null;
    let lastProviderStatus = "";

    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= ANSWER_HEADROOM_MS) break;

      const result = await patchTusChunk({
        uploadUrl,
        headers: auth,
        offset,
        body: slice,
        size: slice.byteLength,
        // Never longer than what is left of the call: a slice the platform kills
        // mid-flight is an answer nobody ever sees.
        timeoutMs: Math.max(1_000, Math.min(CHUNK_TIMEOUT_MS, remaining - ANSWER_HEADROOM_MS)),
      });

      if (result.ok) {
        advanced = result.offset;
        break;
      }

      if (result.status !== undefined) {
        lastProviderStatus = `HTTP ${result.status} ${result.detail}`.trim();

        // Bunny answered, and its answer will not change by sending the same
        // slice again — UNLESS its answer is the one that says it will. 423 is
        // "File is currently being updated. Please try again later", measured
        // against the real library on 2026-09-29 by this very transfer.
        if (!TRANSIENT_4XX.has(result.status) && result.status < 500) {
          return { ok: false, reason: "refused", detail: lastProviderStatus };
        }
      }

      // Either the request never got a reply, or the provider asked for time. A
      // slice can be sent again in both cases — but only from the offset Bunny
      // last confirmed, which is why it is re-asked rather than assumed.
      offset = await tusUploadOffset({ uploadUrl, headers: auth, timeoutMs: CONTROL_TIMEOUT_MS });

      if (deadline - Date.now() <= ANSWER_HEADROOM_MS + REQUEST_RETRY_DELAY_MS) break;
      await sleep(REQUEST_RETRY_DELAY_MS);
    }

    if (advanced === null) {
      // Unfinished, not failed: everything Bunny acknowledged is kept, and the
      // next call continues from there. This is also the ending for a provider
      // that kept asking for time — the page asks again, which is what it asked
      // for, instead of a creator being told their upload failed while it is
      // still moving.
      return {
        ok: false,
        pending: true,
        uploadedBytes: offset,
        totalBytes: total,
        detail:
          lastProviderStatus || `the transfer to the video library did not finish at offset ${offset}`,
      };
    }

    offset = advanced;
  }

  // 5. Bunny holds every byte. The staging copy has done its job — leaving it
  //    behind bills storage for a file that is already in the library, which is
  //    how the bucket came to hold one dead 192 MB object per failed attempt.
  await deleteBucketObject(key);
  await cacheDel(tusUrlKey(videoId));

  return { ok: true, bytes: offset, totalBytes: total };
}

/**
 * Remove the staging copy, best effort.
 *
 * Never throws and never blocks the answer: the creator's video is already in
 * the library, and a bucket that will not let go of a copy must not turn a
 * successful upload into a failure.
 */
async function deleteBucketObject(key: string): Promise<boolean> {
  try {
    const signed = signR2Request({
      r2: config.r2,
      method: "DELETE",
      key,
      date: new Date(),
    });
    const response = await fetch(signed.url, {
      method: "DELETE",
      headers: signed.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch (error) {
    console.warn(
      `[Video Ingest] the staging copy of ${key} could not be removed: ${
        error instanceof Error ? error.name : "UnknownError"
      }`
    );
    return false;
  }
}

