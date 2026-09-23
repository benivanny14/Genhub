// =============================================================================
// GENHUB - Favorites API Route
// GET  /api/favorites - Get user's saved videos
// POST /api/favorites { videoId } - Toggle save (used by the card bookmark)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const favorites = await prisma.favorite.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      include: {
        video: {
          include: {
            creator: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    });

    // Filter out videos that are unpublished or deleted
    const valid = favorites.filter((f) => f.video && f.video.isPublished && !f.video.isDeleted);

    return api.success(valid);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Favorites Error]", error);
    return api.internal();
  }
}

// POST /api/favorites { videoId } - toggle (VideoCard save button)
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

    const existing = await prisma.favorite.findUnique({
      where: { userId_videoId: { userId: auth.userId, videoId } },
    });

    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return api.success({ favorited: false }, "Removed from favourites");
    }

    await prisma.favorite.create({ data: { userId: auth.userId, videoId } });
    return api.success({ favorited: true }, "Saved to favourites");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Favorite Toggle Error]", error);
    return api.internal();
  }
}
