// =============================================================================
// GENHUB - Image delivery
// GET /api/media/<key>
//
// Reads one object out of the Bunny storage zone and streams it back. See
// lib/media.ts for why the app serves its own images instead of linking a CDN
// hostname: the storage zone has no working pull zone, and the hostname that was
// being used belongs to the Stream video library, so every image answered 403.
//
// Access follows the key's first segment:
//   public/...        anyone — feed covers, avatars, video thumbnails
//   private/<userId>/ signed in as that user, or an admin — KYC documents
//   uploads/...       the pre-fix layout. Public, EXCEPT when a KYC row still
//                     points at the key: then it is gated exactly like private/.
//                     That backstop exists because the pre-fix code wrote identity
//                     documents into the same public path as thumbnails, and
//                     publishing somebody's ID is not a bug worth being clever
//                     about. scripts/normalize-media-urls.mjs moves them.
//
// Nothing here trusts the URL: the key must pass isSafeMediaKey (no `..`, no
// scheme, no leading slash) before it can reach an outbound request.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { getCurrentUser } from "@/lib/auth";
import {
  BUNNY_STORAGE_ORIGIN,
  cacheControlFor,
  contentTypeForKey,
  isMediaPrivate,
  isSafeMediaKey,
  mediaKindOf,
  ownerOfPrivateKey,
} from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bunny answers quickly; a storage origin that has gone quiet must not hold a
 *  page's images open until the function timeout. */
const STORAGE_TIMEOUT_MS = 15_000;

/** Big enough for a 5 MB upload plus the JSON wrapper. */
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

/**
 * Local-disk fallback. `private/...` lives in `.media/` (outside the static
 * tree); everything else in `public/uploads/`, which is where the upload route
 * writes it in development.
 */
async function serveFromDisk(key: string): Promise<NextResponse> {
  const root = isMediaPrivate(key) ? ".media" : path.join("public", "uploads");
  const file = path.join(process.cwd(), root, key);

  // The key was validated, so it cannot escape the root — but resolve once more
  // and check, because a symlink or a future validation change should fail
  // closed rather than serve a file from outside the media tree.
  const resolvedRoot = path.resolve(process.cwd(), root);
  if (!path.resolve(file).startsWith(resolvedRoot + path.sep)) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForKey(key),
        "Content-Length": String(info.size),
        "Cache-Control": cacheControlFor(key),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }
}

/**
 * The user id a `uploads/...` key belongs to, when a KYC row references it.
 *
 * A `contains` scan rather than an equality match because the stored value is a
 * full URL (or a `/api/media/...` path), not the bare key. The table is tiny
 * (one row per KYC submission, and none once the migration has run), so this is
 * a cheap safety net rather than a hot query.
 */
async function kycOwnerOfLegacyKey(key: string): Promise<string | null | undefined> {
  const row = await prisma.kycVerification.findFirst({
    where: {
      OR: [{ idDocumentUrl: { contains: key } }, { selfieUrl: { contains: key } }],
    },
    select: { userId: true },
  });
  // `undefined` means "no KYC row points here" — the caller can then treat the
  // key as an ordinary public image.
  return row ? row.userId : undefined;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const { path } = await params;
  const key = (path || []).map((segment) => decodeURIComponent(segment)).join("/");

  if (!isSafeMediaKey(key)) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  // --- Who may read this -----------------------------------------------------
  let ownerId: string | null | undefined = ownerOfPrivateKey(key);

  if (ownerId === null && mediaKindOf(key) === "public" && key.startsWith("uploads/")) {
    ownerId = await kycOwnerOfLegacyKey(key);
  }

  const isGated = ownerId != null;

  if (isGated) {
    const auth = await getCurrentUser();
    if (!auth) {
      return NextResponse.json({ success: false, error: "Sign in required" }, { status: 401 });
    }
    if (auth.userId !== ownerId && auth.role !== "ADMIN") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }
  }

  // --- Fetch it --------------------------------------------------------------
  // Bunny is the production source of truth. Without storage credentials (a
  // laptop, CI) the same keys are read from disk, which is where the upload
  // route put them — so the whole media path can be exercised offline.
  if (!config.bunny.storageZone || !config.bunny.storageAccessKey) {
    return serveFromDisk(key);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BUNNY_STORAGE_ORIGIN}/${config.bunny.storageZone}/${key}`, {
      headers: { AccessKey: config.bunny.storageAccessKey },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      // Images are immutable under one key, so the CDN/edge may hold them.
      cache: "force-cache",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    console.error(
      `[Media] storage fetch failed for ${key}: ${
        name === "TimeoutError" ? `no answer within ${STORAGE_TIMEOUT_MS / 1000}s` : error
      }`
    );
    return NextResponse.json(
      { success: false, error: "Image storage did not answer" },
      { status: 504 }
    );
  }

  if (upstream.status === 404) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`[Media] storage answered ${upstream.status} for ${key}`);
    return NextResponse.json(
      { success: false, error: "Image could not be read" },
      { status: 502 }
    );
  }

  const length = Number(upstream.headers.get("content-length") || 0);
  if (length > MAX_UPSTREAM_BYTES) {
    return NextResponse.json({ success: false, error: "Image too large" }, { status: 502 });
  }

  // Bunny reports the Content-Type it was given at upload time, which is the
  // truth for the bytes. Fall back to the extension only when it is missing —
  // and never echo a text/html type, which would let a crafted upload render as
  // a document in a viewer's origin.
  const upstreamType = (upstream.headers.get("content-type") || "").split(";")[0].trim();
  const contentType =
    upstreamType && /^image\//i.test(upstreamType) && upstreamType !== "image/svg+xml"
      ? upstreamType
      : contentTypeForKey(key);

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControlFor(key),
      // Defense in depth: even a mislabelled file cannot be executed in the
      // site's origin, and referrers never leak media keys to third parties.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(isMediaPrivate(key) ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
    },
  });
}
