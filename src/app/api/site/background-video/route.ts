// =============================================================================
// GENHUB - The background clip behind every page (public read)
// GET  /api/site/background-video?v=<token>
// HEAD /api/site/background-video?v=<token>
//
// Serves the clip an operator set through /api/admin/background-video to every
// browser that loads a page. Public on purpose: it is a backdrop, it is the
// first thing the site paints, and gating it behind a session would make the
// site's own background a request that fails for anyone signed out.
//
// WHERE THE BYTES COME FROM, AND WHY THIS ROUTE IS STILL HERE
//
//   The clip is an object in Cloudflare R2, and it may be 500 MB — far past the
//   4.5 MB a function may return. So there are two ways to answer it, and this
//   route picks whichever the deployment has configured:
//
//   REDIRECT  With a public bucket hostname (R2_PUBLIC_BASE_URL) the answer is a
//             redirect to it. The clip is then carried by the CDN, cached for a
//             year, and this app never touches a byte of it. That is the shape a
//             backdrop wants, and it is what a large clip needs.
//
//   PROXY     Without one, the object is read a range at a time and passed
//             through. Every answer stays inside the platform's payload limit,
//             because a range is bounded (MAX_BACKGROUND_VIDEO_SLICE_BYTES) and
//             browsers ask for ranges anyway — a <video> sends `bytes=0-` before
//             it will play in several of them. Correct, and it pays for the same
//             bytes twice: once at R2 and once here.
//
// WHY THE ADDRESS NEVER CHANGES
//
//   `/api/site/background-video?v=<token>` is the one URL the layer and the
//   admin's card use, and it outlives a replacement — the token in `?v=` is the
//   version. So the clip can be cached hard and a new clip is simply a new
//   address: no stale backdrop, no cache busting anywhere else.
//
// The name in Content-Disposition is a fixed word plus the stored extension —
// never the operator's filename, which would otherwise be reflected to every
// visitor in a header some clients render.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { getBackgroundVideo } from "@/lib/services/platform-setting.service";
import { MAX_BACKGROUND_VIDEO_SLICE_BYTES, backgroundVideoExtension } from "@/lib/background-video";
import { r2BackgroundKeyFor, r2GetObjectRange, r2PublicUrl } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readable but not writable by scripts: this is media, never HTML. */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
} as const;

interface Slice {
  status: 200 | 206;
  start: number;
  end: number;
}

/**
 * Turn a Range header into the slice it asks for, or null if it should be
 * ignored and 416'd.
 *
 * Only the simple one-range form is handled (`bytes=0-499`, `bytes=500-`,
 * `bytes=-500`), because that is the only form browsers send for media and
 * multipart/byteranges responses buy nothing here. A header this route cannot
 * parse is answered with the whole clip, which is what the spec asks for when a
 * server elects not to apply a range it does not understand.
 */
function parseRange(header: string | null, size: number): Slice | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";

  let start: number;
  let end: number;

  if (rawStart === "") {
    // A suffix range: "the last N bytes". `bytes=-0` asks for nothing.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
    if (start > end) return "unsatisfiable";
    // Past the end of the clip is unsatisfiable, not "from here to the end".
    if (start >= size) return "unsatisfiable";
    end = Math.min(end, size - 1);
  }

  if (size === 0) return "unsatisfiable";
  // A real range is ALWAYS answered 206, even when it happens to span the whole
  // clip. A 200 is legal here and fatal in practice: the browser reads it as
  // "this server cannot serve bytes", stops asking for offsets, and for a clip
  // of any real size the download it then waits for never finishes — so the
  // backdrop never plays and never loops. `bytes=0-` is the FIRST thing every
  // <video> sends, so this is not an edge case, it is the normal path.
  return { status: 206, start, end };
}

/** A 404 the layer can act on: it unmounts instead of waiting for bytes. */
function notFound(bodyAllowed: boolean): NextResponse {
  return bodyAllowed
    ? new NextResponse(
        JSON.stringify({ success: false, error: "No background video is set", code: "NOT_FOUND" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" },
        }
      )
    : new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } });
}

async function serve(request: NextRequest, bodyAllowed: boolean) {
  const video = await getBackgroundVideo();
  const key = video.active ? r2BackgroundKeyFor(video.token, video.mimeType) : null;
  // No clip, or a row this app would not have written: both are "nothing to
  // play", and neither may become a request to a store.
  if (!key) return notFound(bodyAllowed);

  const isCurrentVersion = request.nextUrl.searchParams.get("v") === video.token;
  const cacheControl = isCurrentVersion
    ? // A backdrop is the same bytes on every page, at this address, forever.
      "public, max-age=31536000, immutable"
    : // Someone is holding an address from before the clip was replaced. Serve
      // the CURRENT clip so they are not shown a backdrop that no longer exists,
      // but never let that answer be remembered.
      "no-store, max-age=0";

  // --- the CDN path -----------------------------------------------------------
  const publicUrl = r2PublicUrl(key);
  if (publicUrl) {
    // 307: every case that matters is a GET, and a client should follow rather
    // than pin the redirect — the address above is the only one worth caching.
    return NextResponse.redirect(publicUrl, {
      status: 307,
      headers: { "Cache-Control": cacheControl },
    });
  }

  // --- the proxy path ---------------------------------------------------------
  const size = video.size;
  const extension = backgroundVideoExtension(video.mimeType);
  const headers = new Headers({
    "Content-Type": video.mimeType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename="background${extension}"`,
    "Cache-Control": cacheControl,
    ...SECURITY_HEADERS,
  });

  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  // Everything is answered in bounded slices, because a 500 MB clip cannot be
  // sent by a function in one piece at all.
  const start = range ? range.start : 0;
  const wantedEnd = range ? range.end : size - 1;
  const end = Math.min(wantedEnd, start + MAX_BACKGROUND_VIDEO_SLICE_BYTES - 1);
  const isWhole = start === 0 && end === size - 1;

  // A request that CARRIED a Range is always answered 206, even when the range
  // happens to span the whole clip. That last part is not pedantry: `bytes=0-` is
  // the first request every <video> makes, and a 200 there reads to several
  // browsers as "this server cannot serve bytes" — they stop asking for offsets
  // and wait out a download that, on a clip of any real size, never completes.
  //
  // No Range is the ordinary case, and a clip that fits in one slice is answered
  // whole as a 200. One that does NOT fit is the first 206 slice, and the client
  // continues from its own offset.
  const status: 200 | 206 = range || !isWhole ? 206 : 200;

  headers.set("Content-Length", String(end - start + 1));
  if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  if (!bodyAllowed) return new NextResponse(null, { status, headers });

  const upstream = await r2GetObjectRange(key, start, end);
  const wanted = end - start + 1;

  // READ BEFORE ANSWERING, rather than passing the store's stream through.
  //
  // Measured on this route, the pass-through truncated: a 1.1 MB clip arrived as
  // 737,280 bytes, with a Content-Length that promised all of it — which is the
  // worst possible failure for a <video>, because the player waits for bytes the
  // response has already said it would send. Reading the slice into memory first
  // means the body is either complete or it is a 502, and a slice is bounded at
  // MAX_BACKGROUND_VIDEO_SLICE_BYTES, so this never holds more than a couple of
  // megabytes.
  const chunk = upstream?.ok ? Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))) : null;

  if (!upstream?.ok || !chunk || chunk.byteLength !== wanted) {
    console.error(
      `[Background Video Serve] ${key} answered ${upstream?.status ?? "nothing"} for ${start}-${end}` +
        (chunk ? ` (${chunk.byteLength} of ${wanted} bytes)` : "")
    );
    return new NextResponse(
      JSON.stringify({ success: false, error: "That video could not be read right now", code: "UPSTREAM_ERROR" }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  }

  return new NextResponse(chunk as unknown as BodyInit, { status, headers });
}

export async function GET(request: NextRequest) {
  try {
    return await serve(request, true);
  } catch (error) {
    console.error("[Background Video Serve]", error);
    return new NextResponse(JSON.stringify({ success: false, error: "Could not read that video" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" },
    });
  }
}

export async function HEAD(request: NextRequest) {
  try {
    return await serve(request, false);
  } catch (error) {
    console.error("[Background Video Serve HEAD]", error);
    return new NextResponse(null, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
