// =============================================================================
// GENHUB - HLS stream route
// GET /api/videos/[id]/stream[?path=<relative manifest>][&source=teaser]
//
// This is where playback actually starts now.
//
// The player used to be pointed straight at the Bunny CDN with a signed URL,
// which cannot work for HLS on this pull zone: Bunny only honours a token in the
// QUERY STRING, and an HLS player drops the query string when it resolves the
// relative segment URLs inside a manifest. The manifest loaded, and every
// rendition and segment after it came back 403 — the spinner-forever bug.
//
// So the player is pointed here instead. We hold the token secret, fetch the
// manifest with an authorised request, and hand back the same manifest with
// every URI rewritten to carry its own authorisation (lib/hls.ts). Nested
// playlists come back through this route; segments go to the CDN directly, which
// costs one small request per level and no video bandwidth through the app.
//
// Entitlement is re-derived here rather than trusted from the URL, because this
// route is reachable by anyone who can see a page that embedded it: the request
// carries the viewer's cookie, and the answer must be the same one
// GET /api/videos/[id] used before it handed out a playback URL.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import {
  isBunnyPlaybackConfigured,
  isBunnyVideoId,
  signedCdnQuery,
  PLAYBACK_SESSION_MINUTES,
  type StreamSource,
} from "@/lib/bunny";
import { rewriteHlsManifest } from "@/lib/hls";

/** How long the CDN gets to answer before this route gives up on it. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Only MANIFESTS may pass through here.
 *
 * Segments are served by the CDN directly (that is the whole point — video bytes
 * never flow through a serverless function), so the one thing this route fetches
 * is a playlist. Refusing everything else keeps it from becoming an open proxy
 * that would happily stream the entire library through us at our own expense.
 */
function safeManifestPath(raw: string | null): string | null {
  const path = (raw ?? "playlist.m3u8").trim();
  if (!path || path.length > 200) return null;
  if (path.startsWith("/")) return null;
  if (path.includes("..") || path.includes("\\")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  if (!/\.m3u8$/i.test(path)) return null;
  return path;
}

interface GateVideo {
  id: string;
  price: number;
  creatorId: string;
}

/**
 * The same question GET /api/videos/[id] answers before it releases a playback
 * URL — free, purchased, or admin. Answered here again so that a URL copied out
 * of a page is not a bypass: this route never trusts that someone was once
 * allowed to have the link.
 */
async function hasPlaybackAccess(
  video: GateVideo,
  authUser: { userId: string; role: string } | null
): Promise<boolean> {
  if (video.price === 0) return true;
  if (!authUser) return false;
  if (authUser.role === "ADMIN") return true;
  // The owner watching their own upload, most often from "View as viewer".
  if (authUser.userId === video.creatorId) return true;

  const [access, purchase] = await Promise.all([
    prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId: authUser.userId, videoId: video.id } },
      select: { id: true },
    }),
    prisma.transaction.findFirst({
      where: {
        userId: authUser.userId,
        videoId: video.id,
        type: "PPV_PURCHASE",
        status: "SUCCESS",
      },
      select: { id: true },
    }),
  ]);

  return Boolean(access || purchase);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    const search = request.nextUrl.searchParams;
    const source: StreamSource = search.get("source") === "teaser" ? "teaser" : "playback";

    const manifestPath = safeManifestPath(search.get("path"));
    if (!manifestPath) {
      return api.error("Unsupported manifest path", 400, "BAD_REQUEST");
    }

    // Without the secret nothing can be signed, and a manifest of unauthorised
    // URLs is worse than a clear refusal: it would load and then die on the
    // first segment. Say which variable is missing instead.
    if (!isBunnyPlaybackConfigured()) {
      return api.error(
        "Playback is not configured (BUNNY_CDN_HOSTNAME / BUNNY_TOKEN_SECRET)",
        503,
        "NOT_CONFIGURED"
      );
    }

    const video = await prisma.video.findFirst({
      where: { OR: [{ id }, { slug: id }], isDeleted: false },
      select: {
        id: true,
        price: true,
        creatorId: true,
        bunnyVideoId: true,
        teaserBunnyVideoId: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    const authUser = await getCurrentUser();

    let bunnyVideoId: string | null;
    if (source === "teaser" && video.teaserBunnyVideoId) {
      // A trailer is meant for people who have NOT paid, so it needs no
      // entitlement check — but it must be a trailer. Serving `?source=teaser`
      // from the scene's own folder is what the `&&` above prevents.
      bunnyVideoId = video.teaserBunnyVideoId;
    } else {
      const entitled = await hasPlaybackAccess(video, authUser);
      if (!entitled) {
        return api.forbidden("You do not have access to this video");
      }
      bunnyVideoId = video.bunnyVideoId;
    }

    // Demo and side-loaded rows carry no Bunny GUID (the column is non-nullable,
    // so they hold an empty string) — there is nothing at the CDN for them and
    // their playback URL is the stored stream, never this route.
    if (!isBunnyVideoId(bunnyVideoId)) {
      return api.notFound("This video is not hosted on the video CDN");
    }

    // One folder token for everything under it: Bunny honours a signature for
    // `/<guid>/` on every child request (the manifest, each rendition, each
    // segment), which is what makes a rewritten manifest playable. The lifetime
    // is a session, not a moment, because the URLs inside the manifest are used
    // for as long as the viewer watches.
    const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_SESSION_MINUTES * 60;
    const cdnQuery = signedCdnQuery(`/${bunnyVideoId}/`, expiresAt);
    const upstreamPath = `/${bunnyVideoId}/${manifestPath}`;

    let upstream: Response;
    try {
      upstream = await fetch(`https://${config.bunny.cdnHostname}${upstreamPath}?${cdnQuery}`, {
        headers: { Accept: "application/vnd.apple.mpegurl,*/*" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      const name = (error as Error)?.name;
      const detail =
        name === "TimeoutError" || name === "AbortError"
          ? `the video host did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s`
          : (error as Error)?.message || String(error);
      console.error("[Stream Proxy Error]", detail);
      return api.error("The video host could not be reached", 502, "UPSTREAM_UNREACHABLE");
    }

    if (!upstream.ok) {
      // 403 here means the signature itself was refused, which is a deployment
      // fault, not a viewer problem — name the variable, because the only
      // symptom otherwise is a spinner.
      if (upstream.status === 401 || upstream.status === 403) {
        return api.error(
          "The video host refused the signature — BUNNY_TOKEN_SECRET must be this pull zone's Token Authentication Key",
          502,
          "UPSTREAM_REFUSED"
        );
      }
      if (upstream.status === 404) {
        return api.notFound("This video has no playable rendition yet");
      }
      return api.error(`The video host answered HTTP ${upstream.status}`, 502, "UPSTREAM_ERROR");
    }

    const body = await upstream.text();
    const directory = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1)
      : "";

    const rewritten = rewriteHlsManifest(body, {
      cdnHostname: config.bunny.cdnHostname,
      bunnyVideoId,
      cdnQuery,
      // Root-relative so it resolves against whichever host the viewer is on.
      proxyHref:
        source === "teaser"
          ? `/api/videos/${video.id}/stream?source=teaser`
          : `/api/videos/${video.id}/stream`,
      directory,
    });

    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // Per-request tokens live inside this body, so it must never be cached
        // by a shared proxy or poisoned across viewers.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Stream Error]", error);
    return api.internal();
  }
}
