// =============================================================================
// GENHUB - Intro preview route
// GET /api/videos/[id]/intro
//
// Serves Bunny's own animated preview of a scene — the silent ~10 second montage
// Bunny generates for every encoded video — as the automatic INTRO shown to a
// viewer who has not paid, for scenes whose creator never uploaded a trailer.
//
// Why this route exists at all, instead of pointing an <img> at the signed CDN
// URL: this pull zone has hotlink protection enabled, so it answers 403 to any
// request that carries a `Referer` and 200 to the same URL without one. Every
// browser sends a Referer for an <img>, which made a perfectly valid signed URL
// render as a broken image while `curl` on the same URL returned the file — the
// worst shape a bug can have. Fetching server-side (no Referer) fixes it, and as
// a bonus the row's Bunny GUID never reaches the client.
//
// It is NOT a general proxy: the upstream path is fixed to
// `/{bunnyVideoId}/preview.webp`, so it can only ever fetch the animation, never
// a playlist or a segment. The token it uses is signed for that single file —
// verified against the live zone: the same token answers 403 for
// `playlist.m3u8` and for `original`.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { resolveIntroPreviewUrl } from "@/lib/bunny";

/** How long the CDN gets to answer before this route gives up on it. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** The one asset name this route will ever fetch. */
const INTRO_ASSET = "preview.webp";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    const authUser = await getCurrentUser();

    const video = await prisma.video.findFirst({
      where: { OR: [{ id }, { slug: id }], isDeleted: false },
      select: {
        id: true,
        isPublished: true,
        creatorId: true,
        bunnyVideoId: true,
        price: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    // Unpublished is private: the same rule the detail route applies. The owner
    // and an admin may still fetch their own preview (that is what makes "view
    // as visitor" work on a draft), nobody else can.
    const maySeeUnpublished =
      authUser?.userId === video.creatorId || authUser?.role === "ADMIN";
    if (!video.isPublished && !maySeeUnpublished) {
      return api.notFound("Video not found");
    }

    const upstream = resolveIntroPreviewUrl(
      { bunnyVideoId: video.bunnyVideoId },
      // Short-lived on purpose: this route is called at most once per page load,
      // and the browser is told to cache the *bytes* for far longer.
      5
    );
    if (!upstream) return api.notFound("No intro preview for this video");

    let response: Response;
    try {
      // No `Referer` (and no cookie) is sent: that is precisely what the pull
      // zone refuses. The authorisation is in the URL.
      response = await fetch(upstream, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return api.error("The video host did not answer", 504);
    }

    if (!response.ok) {
      // Bunny answers 404 when the library has previews switched off. That is a
      // valid state, not an outage — the page falls back to its locked card.
      return api.notFound("No intro preview for this video");
    }

    const body = await response.arrayBuffer();
    if (body.byteLength === 0) {
      return api.notFound("No intro preview for this video");
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        // Fixed for every caller — the upstream path is not taken from the
        // request, so there is nothing here to influence.
        "Content-Type": response.headers.get("content-type") || "image/webp",
        // Private: the visibility guard above depends on who is asking for a
        // draft, so a shared cache must not hold one answer for everybody.
        "Cache-Control": "private, max-age=21600",
        "X-Intro-Asset": INTRO_ASSET,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Intro Preview Error]", error);
    return api.internal();
  }
}
