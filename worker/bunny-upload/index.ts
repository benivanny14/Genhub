// =============================================================================
// GENHUB - Upload proxy
//
// ONE JOB: accept a PUT from a creator's browser, check the token this server
// signed for that one video id, and stream the body on to Bunny with the library
// key attached. The key never leaves this Worker, and this Worker never sees the
// file as a whole — `request.body` is handed straight to `fetch`, so a 90 MB
// upload costs a few kilobytes of memory rather than 90.
//
// WHY THIS EXISTS AT ALL. Bunny's one-shot PUT authenticates with the library
// API key, which manages every video in the library: upload, delete, rename, and
// read. Putting it in a browser would mean anyone who opens DevTools can empty
// Genhub. Bunny's answer for browsers is a signed resume endpoint (what
// lib/tus-upload.ts uses); this Worker is the other answer, for the single-PUT
// transport the app now also offers (lib/upload-put.ts).
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * list, read, rename or delete anything — the only Bunny call it can make is
//     an upload into a video id that Genhub's server already reserved;
//   * trust the caller for anything but the bytes: the video id comes from the
//     token, not from the request, so a valid token cannot be pointed at a
//     different slot;
//   * buffer the body. It cannot: a Worker's memory limit is smaller than the
//     files creators send.
//
// DEPLOY: see README.md beside this file. Until BUNNY_UPLOAD_PROXY_URL and
// BUNNY_UPLOAD_PROXY_SECRET are set on the Next deployment, the app does not use
// this path at all and uploads stay on the resumable one.
// =============================================================================

import { verifyUploadProxyToken } from "../../src/lib/upload-proxy-token";

interface Env {
  /** Stream library id. Not a secret; it is in every playback URL. */
  BUNNY_STREAM_LIBRARY_ID: string;
  /** Stream API key. A SECRET — set with `wrangler secret put`. */
  BUNNY_STREAM_API_KEY: string;
  /** Shared with the Next deployment. A SECRET — set with `wrangler secret put`. */
  BUNNY_UPLOAD_PROXY_SECRET: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS: string;
  /** Optional ceiling for one request body, in bytes. */
  MAX_UPLOAD_BYTES?: string;
}

const BUNNY_STREAM_API = "https://video.bunnycdn.com";

/** The library's own ceiling; anything past this is refused by Bunny anyway. */
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

/**
 * CORS headers, per request.
 *
 * Echoed rather than wildcarded so the answer stays correct if a second origin
 * (a preview deployment) is ever added: a wildcard here would be a standing
 * invitation to call this Worker from anywhere, and the only thing standing
 * between that and an upload is the token.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedOrigin(request, env);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/**
 * The Worker's whole surface, named rather than inlined into `export default`.
 *
 * Wrangler wants a default export carrying `fetch`; a name here (and not in
 * `wrangler.toml`) is what keeps `import/no-anonymous-default-export` — which
 * is on for every other file in this repo — satisfied for this one too.
 */
const uploadProxy = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // A GET is a liveness check an operator can run with curl, and it answers
    // without revealing whether the secrets are set beyond a boolean.
    if (request.method === "GET") {
      return json(
        {
          ok: true,
          libraryConfigured: Boolean(env.BUNNY_STREAM_LIBRARY_ID && env.BUNNY_STREAM_API_KEY),
          secretConfigured: Boolean(env.BUNNY_UPLOAD_PROXY_SECRET),
        },
        200,
        cors
      );
    }

    if (request.method !== "PUT") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (!env.BUNNY_STREAM_LIBRARY_ID || !env.BUNNY_STREAM_API_KEY) {
      return json({ error: "Upload proxy is not configured" }, 503, cors);
    }

    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId") || "";
    const expiresAt = Number(url.searchParams.get("expires") || "0");
    const token = url.searchParams.get("sig") || "";

    // Authorized BEFORE the body is touched, which is the point of putting the
    // token in the URL: an unauthorized request is refused without reading a
    // byte of a file we would only have to discard.
    const authorized = await verifyUploadProxyToken({
      secret: env.BUNNY_UPLOAD_PROXY_SECRET,
      videoId,
      expiresAt,
      token,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!authorized) {
      return json(
        {
          error:
            "This upload is no longer authorized. Start the upload again from Genhub.",
        },
        401,
        cors
      );
    }

    const maxBytes = Number(env.MAX_UPLOAD_BYTES || "") || DEFAULT_MAX_UPLOAD_BYTES;
    const declared = Number(request.headers.get("Content-Length") || "0");
    // Refused by name before any of it is transferred: a creator whose file is
    // too big for one request should be told that, not left watching a bar.
    //
    // This reads the DECLARED length, and that is a deliberate limit rather than
    // an oversight: counting the stream as it goes can only refuse a transfer
    // that has already started, which is the thing worth avoiding. A browser
    // uploading a File always knows its size and sends this header, and the
    // client refuses an oversized file before it ever asks this Worker — so the
    // only requests without one are not browsers. The hard ceiling is
    // Cloudflare's own per-plan request-body limit, enforced at the edge
    // whatever any header says, with Bunny's file-size limit behind it.
    if (declared > maxBytes) {
      return json(
        {
          error: `That file is larger than this upload path accepts (${maxBytes} bytes). It will be sent in pieces instead.`,
        },
        413,
        cors
      );
    }

    const upstream = await fetch(
      `${BUNNY_STREAM_API}/library/${encodeURIComponent(env.BUNNY_STREAM_LIBRARY_ID)}/videos/${encodeURIComponent(videoId)}`,
      {
        method: "PUT",
        headers: {
          // The whole reason this Worker exists.
          AccessKey: env.BUNNY_STREAM_API_KEY,
          "Content-Type": "application/octet-stream",
        },
        // Streamed, not buffered: `request.body` is a ReadableStream and Bunny
        // consumes it as it arrives.
        body: request.body,
      }
    );

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};

export default uploadProxy;
