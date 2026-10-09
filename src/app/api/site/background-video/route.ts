// =============================================================================
// GENHUB - The background clip behind every page (public read)
// GET  /api/site/background-video?v=<token>
// HEAD /api/site/background-video?v=<token>
//
// Serves the file an operator set through /api/admin/background-video to every
// browser that loads a page. Public on purpose: it is a backdrop, it is the
// first thing the site paints, and gating it behind a session would make the
// site's own background a request that fails for anyone signed out.
//
// WHY ITS OWN ROUTE INSTEAD OF `public/uploads/...`
//
//   1. RANGE. A <video> asks for bytes=… as soon as it wants to seek, and it
//      asks before it will play in several browsers. A server that answers a
//      range request with the whole file and a 200 is a server those browsers
//      treat as unable to stream. So 206, Content-Range and Accept-Ranges are
//      written here rather than left to whatever static handler is in front.
//   2. ONE ADDRESS. The path never changes; `?v=` carries the token. The clip
//      can then be cached hard (a backdrop is the same bytes on every page) and
//      a replacement is simply a different URL — no stale backdrop, no cache
//      busting on the query.
//   3. NO PATH. The file is opened from the validated row, never from anything
//      in the query string. The token in `?v=` only decides which CACHE a
//      response gets: matching means "this is the file I intended", so it may
//      be kept for a year.
//
// The name in Content-Disposition is a fixed word plus the stored extension —
// never the operator's filename, which would otherwise be reflected to every
// visitor in a header that some clients render.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getBackgroundVideo } from "@/lib/services/platform-setting.service";
import { backgroundVideoRelativePath } from "@/lib/background-video";

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
 * parse is answered with the whole file, which is what the spec asks for when
 * a server elects not to apply a range it does not understand.
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
    // Past the end of the file is unsatisfiable, not "from here to the end".
    if (start >= size) return "unsatisfiable";
    end = Math.min(end, size - 1);
  }

  if (size === 0) return "unsatisfiable";
  // 206 even when the range happens to span the whole file. A 200 is legal
  // here and fatal in practice: the browser reads it as "this server cannot
  // serve bytes", stops asking for offsets, and for a clip of any real size
  // the download it then waits for never finishes — so the backdrop never
  // plays and never loops. `bytes=0-` is the FIRST thing every <video> sends,
  // so this is not an edge case, it is the normal path.
  return { status: 206, start, end };
}

async function serve(request: NextRequest, bodyAllowed: boolean) {
  const video = await getBackgroundVideo();
  const relative = backgroundVideoRelativePath(video);
  if (!video.active || !relative) {
    return bodyAllowed
      ? new NextResponse(JSON.stringify({ success: false, error: "No background video is set", code: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" },
        })
      : new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  const absolute = path.join(process.cwd(), relative);

  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    // The row survived but the file did not. Answering 404 lets the layer
    // unmount rather than spin on a request that will never return bytes.
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  const requestedVersion = request.nextUrl.searchParams.get("v");
  const isCurrentVersion = requestedVersion === video.token;

  const headers = new Headers({
    "Content-Type": video.mimeType,
    "Accept-Ranges": "bytes",
    // A fixed word, never the operator's filename — see the header.
    "Content-Disposition": `inline; filename="background${relative.slice(
      relative.lastIndexOf(".")
    )}"`,
    "Cache-Control": isCurrentVersion
      ? "public, max-age=31536000, immutable"
      : // Someone is holding an address from before the clip was replaced. Serve
        // the CURRENT file so they are not shown a backdrop that no longer
        // exists, but never let that answer be remembered.
        "no-store, max-age=0",
    ...SECURITY_HEADERS,
  });

  const range = parseRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }

  const slice: Slice = range ?? { status: 200, start: 0, end: size - 1 };
  headers.set("Content-Length", String(slice.end - slice.start + 1));
  if (slice.status === 206) {
    headers.set("Content-Range", `bytes ${slice.start}-${slice.end}/${size}`);
  }

  if (!bodyAllowed) return new NextResponse(null, { status: slice.status, headers });

  const stream = Readable.toWeb(
    createReadStream(absolute, { start: slice.start, end: slice.end })
  ) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(stream, { status: slice.status, headers });
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
