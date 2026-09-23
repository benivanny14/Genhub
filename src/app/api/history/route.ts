// =============================================================================
// GENHUB - Watch History API Route
// GET /api/history - Recently watched videos with progress (Continue Watching)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const history = await prisma.watchProgress.findMany({
      where: { userId: auth.userId },
      orderBy: { updatedAt: "desc" },
      take: 12,
      include: {
        video: {
          select: {
            id: true,
            title: true,
            slug: true,
            thumbnailUrl: true,
            price: true,
            duration: true,
            isPublished: true,
            isDeleted: true,
            creator: { select: { id: true, displayName: true } },
          },
        },
      },
    });

    const videos = history
      .filter((h) => h.video.isPublished && !h.video.isDeleted && h.percent > 0)
      .map((h) => ({
        id: h.video.id,
        title: h.video.title,
        slug: h.video.slug,
        thumbnailUrl: h.video.thumbnailUrl,
        price: h.video.price,
        duration: h.video.duration,
        creator: h.video.creator,
        percent: h.percent,
        positionSeconds: h.positionSeconds,
        watchedAt: h.updatedAt,
      }));

    return api.success({ videos });
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Watch History Error]", error);
    return api.internal();
  }
}
