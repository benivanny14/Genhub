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
// This Worker does the move instead, and it is deliberately the most boring
// version of it: read one object from the bucket, PUT it to one video id, report
// what Bunny said. The video id is inside the token (see
// lib/video-ingest-token.ts), so the request cannot be made to write into a slot
// it was not signed for, and a retry is idempotent — the same file, into the
// same slot, as many times as it takes.
//
// WHAT IT OWNS. The Bunny library key, which is why the browser never talks to
// this Worker: the browser uploads to R2 with a presigned URL of its own, and
// this hop is server to server. The Worker holds no credential for the bucket
// beyond a binding that can only read the one object it is told to read.
//
// Deploy: see README.md beside this file.
// =============================================================================

import { verifyVideoIngestToken } from "../../src/lib/video-ingest-token";

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
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

interface Env {
  BUCKET?: R2BucketLike;
  VIDEO_INGEST_SECRET?: string;
  BUNNY_STREAM_API_KEY?: string;
  BUNNY_STREAM_LIBRARY_ID?: string;
}

const BUNNY_API = "https://video.bunnycdn.com";

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

/**
 * How long the transfer to Bunny is given before it is called a failure.
 *
 * Generous on purpose: this is a whole video over Cloudflare's own network, and
 * a slow ingest that succeeds is worth more than a fast one that is abandoned
 * and retried from the beginning.
 */
const INGEST_TIMEOUT_MS = 15 * 60 * 1000;

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

    const object = await env.BUCKET.get(key);
    if (!object) {
      // Authorized, so this answer is true rather than a decoy: the upload never
      // finished, or the object was swept before the ingest ran.
      return json({ error: "Uploaded file not found" }, 404);
    }

    // Streamed, not buffered: the body is the video, and reading it into memory
    // first would bound this to the Worker's memory limit instead of to the size
    // of the file.
    const bunnyResponse = await fetch(
      `${BUNNY_API}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`,
      {
        method: "PUT",
        headers: {
          // The key the browser can never hold. Added here, on the way out.
          AccessKey: env.BUNNY_STREAM_API_KEY,
          "Content-Type": "application/octet-stream",
        },
        body: object.body,
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      }
    );

    const detail = await bunnyResponse.text();

    if (!bunnyResponse.ok) {
      // Bunny's own words, passed back verbatim: 401 here means the library key
      // was rejected, 404 means the reserved slot is gone, and an operator can
      // act on both without reading our source.
      return json(
        {
          error: "The video library refused the file",
          bunnyStatus: bunnyResponse.status,
          bunnyBody: detail.slice(0, 600),
        },
        502
      );
    }

    return json({ ok: true, bytes: object.size, bunnyBody: detail.slice(0, 200) }, 200);
  },
};

// Named before exporting: a default-exported object literal cannot be reviewed,
// imported under the name of the handler, or replaced in a test.
export default worker;
