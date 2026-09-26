// =============================================================================
// GENHUB - Intro clip route
// GET /api/videos/[id]/intro-clip
//
// Serves a real trailer for a scene the viewer has NOT paid for: an HLS playlist
// made of four ~4 second pieces of the scene itself — the opening, the middle,
// a little further in, and the end. The plan is lib/intro-clip.ts; this file is
// the part that talks to the CDN and signs what it found.
//
// WHY THIS IS NOT A PAYWALL HOLE. Handing a non-buyer a manifest of the scene's
// own segments sounds like handing over the scene, so the safety argument has to
// be exact:
//
//   1. THE ROUTE TAKES NO INPUT. There is no `?path=`, no `?segment=`, no
//      rendition parameter — nothing the client can name. The only thing the
//      request carries is the row id in the URL path, and the segment set is
//      recomputed from the scene's own playlist on every request. Compare the
//      playback route, which takes `?path=` and therefore has to police it with
//      safeManifestPath(); here there is nothing to police.
//   2. EVERY URL IS SIGNED FOR ONE FILE. Measured against the live pull zone
//      (scripts/.probe-scope.mjs): a token signed for `…/360p/video0.ts` answers
//      403 for `video7.ts`, for both manifests, for `play_360p.mp4`, and for
//      another video's segments, and a forged token is refused everywhere. So the
//      most a viewer can obtain is the sixteen seconds named in the manifest —
//      the folder is never signed, not even to read the playlists (those are
//      signed per file too, in `fetchWithToken` below).
//   3. THE PLAN LEAVES SOME OF THE SCENE OUT: at least one segment always stays
//      out, and the clip never exceeds half the running time. A short scene gets
//      fewer windows for that reason.
//
// A 404 from here is a normal answer, not an outage: it means the scene has no
// usable playlist (still encoding, or not Bunny-hosted at all), and the watch
// page falls back to Bunny's animated preview.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import { isBunnyPlaybackConfigured, isBunnyVideoId, signedBunnyFileUrl } from "@/lib/bunny";
import {
  buildClipManifest,
  parseMasterVariants,
  parseMediaPlaylist,
  pickClipVariant,
  planClipSegments,
} from "@/lib/intro-clip";

/** How long the CDN gets to answer one playlist request. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** The master playlist Bunny serves for every Stream video. */
const MASTER_PLAYLIST = "playlist.m3u8";

/**
 * One authorised playlist fetch.
 *
 * No `Referer` and no cookie are sent: this pull zone refuses any request that
 * carries a Referer (measured — see the intro route), which is why the fetch
 * happens here rather than in the browser. The authorisation is in the URL.
 */
async function fetchWithToken(
  bunnyVideoId: string,
  relativePath: string
): Promise<{ ok: true; body: string } | { ok: false; status: number | "timeout" }> {
  const url = signedBunnyFileUrl(bunnyVideoId, relativePath);
  if (!url) return { ok: false, status: 500 };

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.apple.mpegurl,*/*" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, body: await response.text() };
  } catch {
    return { ok: false, status: "timeout" };
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;

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
        isPublished: true,
        creatorId: true,
        bunnyVideoId: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    // Unpublished is private, exactly as it is on the detail and intro routes: a
    // draft that has not been released has no trailer to shop with either. The
    // owner and an admin still see theirs, which is what "view as visitor" needs.
    const authUser = await getCurrentUser();
    const maySeeUnpublished =
      authUser?.userId === video.creatorId || authUser?.role === "ADMIN";
    if (!video.isPublished && !maySeeUnpublished) {
      return api.notFound("Video not found");
    }

    if (!isBunnyVideoId(video.bunnyVideoId)) {
      return api.notFound("This scene has no intro clip");
    }

    const master = await fetchWithToken(video.bunnyVideoId, MASTER_PLAYLIST);
    if (!master.ok) {
      // 403 means the signature itself was refused, which is a deployment fault
      // and not a viewer problem — name the variable, because the symptom inside
      // the app (a card with no motion) says nothing about the cause.
      if (master.status === 401 || master.status === 403) {
        return api.error(
          `The video host refused the signature (HTTP ${master.status} from ${config.bunny.cdnHostname}) — ` +
            "BUNNY_TOKEN_SECRET must be this pull zone's Token Authentication Key, copied exactly",
          502,
          "UPSTREAM_REFUSED"
        );
      }
      return api.notFound("This scene has no intro clip yet");
    }

    const variant = pickClipVariant(parseMasterVariants(master.body));
    if (!variant) return api.notFound("This scene has no intro clip yet");

    const renditionPath = variant.uri.replace(/^\/+/, "");
    const rendition = await fetchWithToken(video.bunnyVideoId, renditionPath);
    if (!rendition.ok) {
      return api.notFound("This scene has no intro clip yet");
    }

    const parsed = parseMediaPlaylist(rendition.body);
    const plan = planClipSegments(parsed.segments);
    if (plan.indices.length === 0) {
      return api.notFound("This scene has no intro clip yet");
    }

    const directory = renditionPath.includes("/")
      ? renditionPath.slice(0, renditionPath.lastIndexOf("/") + 1)
      : "";

    const manifest = buildClipManifest({
      segments: parsed.segments,
      indices: plan.indices,
      directory,
      version: parsed.version,
      // One signature per file, signed for that file alone.
      signUrl: (relativePath) =>
        signedBunnyFileUrl(video.bunnyVideoId, relativePath) ?? "",
    });

    if (!manifest) return api.notFound("This scene has no intro clip yet");

    return new NextResponse(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // The body carries expiring signatures, so it must never sit in a shared
        // cache. A short private cache is worth having all the same: the card
        // hover and the watch page ask for the same manifest, and the tokens
        // inside outlive that window by design.
        "Cache-Control": "private, max-age=300",
        "X-Intro-Clip": `${plan.indices.length} segment(s) of ${parsed.segments.length}`,
        "X-Intro-Clip-Seconds": plan.duration.toFixed(1),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Intro Clip Error]", error);
    return api.internal();
  }
}
