// =============================================================================
// GENHUB - Watch Later API Route
// GET  /api/watch-later            - ids + count in the user's Watch Later
// POST /api/watch-later { videoId } - toggle a video in/out of Watch Later
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { toggleWatchLater, watchLaterIds } from "@/lib/services/playlist.service";

export async function GET() {
  try {
    const auth = await requireAuth();
    const ids = await watchLaterIds(auth.userId);
    return api.success({ videoIds: ids, count: ids.length });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Watch Later Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const videoId = (body?.videoId || "").toString();
    if (!videoId) return api.validation("videoId is required");

    const video = await prisma.video.findFirst({
      where: { id: videoId, isPublished: true, isDeleted: false },
      select: { id: true },
    });
    if (!video) return api.notFound("Video not found");

    const result = await toggleWatchLater(auth.userId, videoId);

    return api.success(
      result,
      result.added ? "Added to Watch Later" : "Removed from Watch Later"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Watch Later Toggle Error]", error);
    return api.internal();
  }
}
