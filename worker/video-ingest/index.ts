// =============================================================================
// GENHUB - The ingest: from the private bucket into the reserved Bunny slot
//   worker/video-ingest
//
// WHY THIS WORKER EXISTS, AND WHY BUNNY DOES NOT FETCH FOR US. The obvious way
// to move a finished upload into Bunny is Bunny's own fetch API, and it is the
// one thing that cannot be used here: `POST /library/{id}/videos/fetch` creates
// a video object of its own and its documented (and observed) response carries
// no guid —
//
//     { "success": true, "message": "OK", "statusCode": 200 }
//
// — so it can neither fill the slot this server already reserved for the
// creator's post, nor be retried safely, because a second call is a second
// video with a second guid whose bytes are the same file. Everything downstream
// in Genhub is keyed on the Bunny guid (the row, the webhook, the encode
// lifecycle), so a guid we have to go and hunt for is a guid that can be hunted
// for wrongly.
//
// This Worker does the move instead. The video id is inside the token (see
// lib/video-ingest-token.ts), so the request cannot be made to write into a slot
// it was not signed for, and a retry writes the same file into the same slot.
//
// WHY IT SENDS THE FILE IN PIECES. It used to send the whole object as ONE PUT,
// and that cannot work from inside a Worker: Cloudflare caps a subrequest's
// request body at **100 MB** (Free and Pro; 200 MB Business), and Genhub accepts
// up to 2 GB. Measured on 2026-09-29 with a real creator's file: a 1 MB object
// went through this exact code path and Bunny answered normally, while a 192 MB
// object made the Worker throw in **1.8 seconds** — before Bunny was reached —
// and the caller received Cloudflare's HTML "Worker threw exception" page
// instead of any JSON, which is why the failure named nothing.
//
// So it uses Bunny's TUS endpoint, which is the resumable protocol Bunny itself
// recommends for large files, and it sends the object in 64 MB PATCHes: each one
// is under the platform's cap, each one is a request that can be retried on its
// own, and Bunny answers every PATCH with the offset it now holds — which is
// also what lets a second attempt CONTINUE an upload a first one left half done
// instead of starting a two-gigabyte transfer again.
//
// Verified live against the real library before this shipped: create → 201 with
// a relative Location, PATCH → 204 with `Upload-Offset` advanced by exactly the
// bytes sent. Two details that are easy to get wrong are pinned in tests: the
// Location is relative and must be resolved against the API host, and the
// Authorization headers are revalidated on EVERY POST, HEAD and PATCH — a PATCH
// without LibraryId is answered 400 "Library ID missing or invalid".
//
// WHAT IT OWNS. The Bunny library key, which is why the browser never talks to
// this Worker: the browser uploads to R2 with a presigned URL of its own, and
// this hop is server to server. The Worker holds no credential for the bucket
// beyond a binding that can only read the one object it is told to read.
//
// IT IS NOT REQUIRED ANY MORE, AND THAT IS THE POINT OF THE DATE ABOVE. Deploying
// it is a step outside the application's own deploy, and measured on 2026-09-29
// the step had not been taken: production was still serving the single-PUT
// version, so a 192 MB file that had ALREADY reached the bucket failed at 100%
// with Cloudflare's HTML error page and no reason anywhere the app could read.
// The move is now made by lib/services/video-ingest.service.ts — this
// application's own server, on its own deploy, in the same budgeted TUS chunks —
// and this Worker is an alternative path for anyone who would rather the bytes
// crossed inside Cloudflare and never touched a serverless function's egress.
// The two share every protocol rule (lib/bunny-tus.ts), and they must not be run
// at the same time for one video: they are two transfers into one slot.
//
// Deploy: see README.md beside this file.
// =============================================================================

import { verifyVideoIngestToken } from "../../src/lib/video-ingest-token";
import {
  createTusUpload,
  patchTusChunk,
  TUS_AUTH_TTL_SECONDS,
  tusAuthHeaders,
  tusUploadOffset,
} from "../../src/lib/bunny-tus";

/**
 * The shape this Worker needs, declared here rather than pulled from
 * @cloudflare/workers-types.
 *
 * The worker is typechecked by the application's own `tsc --noEmit`, and adding
 * a whole package of Cloudflare globals to that would put them in scope for
 * every file in src/ — where `Request` already means something slightly
 * different. Structural types keep the Worker honest without changing what the
 * application sees.
 */
interface R2ObjectBodyLike {
  body: ReadableStream;
  size: number;
}

interface R2BucketLike {
  /** Metadata only, for the transfer's LENGTH before a byte of it moves. */
  head(key: string): Promise<{ size: number } | null>;
  /**
   * One object, or one slice of it. The range is what keeps every PATCH under
   * the platform's request-body cap without ever holding the whole file in the
   * Worker's memory — the file is read piece by piece and never buffered.
   */
  get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<R2ObjectBodyLike | null>;
}

interface Env {
  BUCKET?: R2BucketLike;
  VIDEO_INGEST_SECRET?: string;
  BUNNY_STREAM_API_KEY?: string;
  BUNNY_STREAM_LIBRARY_ID?: string;
}

/**
 * How much of the file one PATCH carries.
 *
 * Under the platform's 100 MB request-body cap with room to spare, and large
 * enough that a 2 GiB video is 32 requests rather than hundreds: fewer requests
 * is fewer round trips over a link this Worker does not control, and each one is
 * still small enough to be retried on its own.
 */
export const CHUNK_BYTES = 64 * 1024 * 1024;

/** How long one PATCH may take before it is abandoned and retried. */
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long the whole transfer may take before it stops and says so.
 *
 * A bound rather than a hope: the caller gives up long before this (55s in
 * lib/services/video-ingest.service.ts), and a Worker that kept moving a
 * two-gigabyte file after the caller stopped listening would be work nobody can
 * see the result of. What is already sent is kept by Bunny, so stopping here
 * costs the next attempt nothing but the time to resume.
 */
const TRANSFER_BUDGET_MS = 20 * 60 * 1000;

type TransferOutcome =
  | { ok: true; bytes: number; chunks: number }
  | { ok: false; status: number; detail: string };

/**
 * Move one object into one Bunny slot, in chunks, resuming if it has to.
 *
 * Never throws: every ending is a value the caller can turn into a JSON answer,
 * because the last time this Worker threw, the creator's browser got an HTML
 * error page from Cloudflare and the app could only say "could not be handed to
 * the video service" with no reason in it anywhere.
 */
async function transferToBunny(params: {
  bucket: R2BucketLike;
  key: string;
  videoId: string;
  total: number;
  libraryId: string;
  apiKey: string;
}): Promise<TransferOutcome> {
  const { bucket, key, videoId, total, libraryId, apiKey } = params;

  const startedAt = Date.now();
  const auth = await tusAuthHeaders({
    libraryId,
    apiKey,
    videoId,
    expiresAt: Math.floor(startedAt / 1000) + TUS_AUTH_TTL_SECONDS,
  });

  try {
    // 1. Open the upload against the slot this server reserved. Every rule of
    //    Bunny's protocol — the relative Location that has to be resolved, the
    //    signature revalidated on every request, the required base64 metadata —
    //    lives in lib/bunny-tus.ts, shared with the application's own ingest so
    //    there is one implementation of them rather than one per runtime.
    const created = await createTusUpload({
      libraryId,
      apiKey,
      videoId,
      total,
      expiresAt: Number(auth.AuthorizationExpire),
    });
    if (!created.ok) {
      return { ok: false, status: created.status, detail: created.detail };
    }

    const uploadUrl = created.uploadUrl;
    let offset = await tusUploadOffset({ uploadUrl, headers: auth });
    let chunks = 0;

    // 2. Send what is missing, one piece at a time. Read from the bucket by
    //    RANGE: the file is never held in the Worker's memory, and each request
    //    body stays under the cap that made the single PUT impossible.
    while (offset < total) {
      if (Date.now() - startedAt > TRANSFER_BUDGET_MS) {
        return {
          ok: false,
          status: 504,
          detail: `stopped after ${offset} of ${total} bytes to stay inside one invocation`,
        };
      }

      const length = Math.min(CHUNK_BYTES, total - offset);
      const slice = await bucket.get(key, { range: { offset, length } });
      if (!slice) {
        // The object was there a moment ago, so this is the bucket, not the
        // creator: said plainly rather than reported as a failed upload.
        return { ok: false, status: 404, detail: "Uploaded file not found" };
      }

      let advanced: number | null = null;
      let thrown: string | null = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await patchTusChunk({
          uploadUrl,
          headers: auth,
          offset,
          body: slice.body,
          size: slice.size,
          timeoutMs: CHUNK_TIMEOUT_MS,
        });

        if (result.ok) {
          // Bunny's own figure, so progress cannot run ahead of what it holds.
          advanced = result.offset;
          break;
        }

        // A refusal is Bunny's answer and repeating it changes nothing.
        if (result.status !== undefined) {
          return { ok: false, status: result.status, detail: result.detail };
        }

        // A thrown fetch is the connection to Bunny, and a chunk is a request
        // that can be sent again — but only from the offset Bunny last
        // confirmed, so the range is re-read rather than reused.
        thrown = result.detail;
      }

      if (advanced === null) {
        return {
          ok: false,
          status: 502,
          detail: `the transfer to the video library failed after 3 attempts at offset ${offset} (${thrown ?? "no detail"})`,
        };
      }

      offset = advanced;
      chunks += 1;
    }

    return { ok: true, bytes: offset, chunks };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    return { ok: false, status: 502, detail: `${name}: ${message.slice(0, 300)}` };
  }
}

/** Never echoes a secret, and says only whether the pieces are in place. */
function liveness(env: Env): Response {
  return Response.json({
    ok: true,
    bucketConfigured: Boolean(env.BUCKET),
    secretConfigured: Boolean(env.VIDEO_INGEST_SECRET),
    bunnyConfigured: Boolean(env.BUNNY_STREAM_API_KEY && env.BUNNY_STREAM_LIBRARY_ID),
  });
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

// The old single 15-minute PUT timeout is gone with the single PUT. Its
// replacements are CHUNK_TIMEOUT_MS (per piece, so one slow piece is retried
// rather than the whole transfer abandoned) and TRANSFER_BUDGET_MS (the whole
// thing, so the Worker cannot outlive any use of its answer).

export function parseIngestRequest(url: URL) {
  return {
    key: url.searchParams.get("key") ?? "",
    videoId: url.searchParams.get("videoId") ?? "",
    expiresAt: Number(url.searchParams.get("expires") ?? ""),
    token: url.searchParams.get("sig") ?? "",
  };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return liveness(env);

    if (url.pathname !== "/ingest") {
      return json({ error: "Not found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const { key, videoId, expiresAt, token } = parseIngestRequest(url);

    // Authorization before anything else: an unauthorized call must not reveal
    // whether the object exists, how big it is, or whether Bunny is configured.
    if (!key || !videoId) return json({ error: "Missing key or videoId" }, 400);
    if (!env.VIDEO_INGEST_SECRET) return json({ error: "This ingest is not configured" }, 500);

    const authorized = await verifyVideoIngestToken({
      secret: env.VIDEO_INGEST_SECRET,
      key,
      videoId,
      expiresAt,
      token,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!authorized) {
      return json({ error: "This upload is no longer authorized. Upload it again." }, 401);
    }

    if (!env.BUCKET) return json({ error: "This ingest has no bucket" }, 500);
    if (!env.BUNNY_STREAM_API_KEY || !env.BUNNY_STREAM_LIBRARY_ID) {
      return json({ error: "The video library is not configured" }, 500);
    }


    // The LENGTH first, from metadata: a TUS upload has to declare how long it
    // is before the first byte moves, and head() is the cheap way to know — it
    // reads no object body at all.
    const head = await env.BUCKET.head(key);
    if (!head) {
      // Authorized, so this answer is true rather than a decoy: the upload never
      // finished, or the object was swept before the ingest ran.
      return json({ error: "Uploaded file not found" }, 404);
    }

    const outcome = await transferToBunny({
      bucket: env.BUCKET,
      key,
      videoId,
      total: head.size,
      libraryId: env.BUNNY_STREAM_LIBRARY_ID,
      apiKey: env.BUNNY_STREAM_API_KEY,
    });

    if (!outcome.ok) {
      // Our own two answers first. `not-uploaded` is read by the caller as "ask
      // the creator to upload again", and the token refusal has its own
      // sentence, so neither may be reported as a library problem.
      if (outcome.status === 404) return json({ error: "Uploaded file not found" }, 404);

      // Everything else is Bunny's, passed back with its own words: 401 here
      // means the library key was rejected, 404 means the reserved slot is gone,
      // and an operator can act on both without reading our source. A 5xx is
      // Bunny's or the network's, and the caller retries it.
      return json(
        {
          error: "The video library would not take the file",
          bunnyStatus: outcome.status,
          bunnyBody: outcome.detail,
        },
        502
      );
    }

    return json({ ok: true, bytes: outcome.bytes, chunks: outcome.chunks }, 200);
  },
};

// Named before exporting: a default-exported object literal cannot be reviewed,
// imported under the name of the handler, or replaced in a test.
export default worker;
