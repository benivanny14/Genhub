// =============================================================================
// GENHUB - Video Interactions (Like / Dislike / Favorite)
// POST /api/videos/[id]/interactions - Toggle like, dislike, or favorite
// GET /api/videos/[id]/interactions - Get interaction status
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

// GET /api/videos/[id]/interactions
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();

    const video = await prisma.video.findUnique({
      where: { id },
      select: { likesCount: true, dislikesCount: true },
    });

    if (!user) {
      return api.success({
        liked: false,
        disliked: false,
        favorited: false,
        likesCount: video?.likesCount || 0,
        dislikesCount: video?.dislikesCount || 0,
      });
    }

    const [like, favorite] = await Promise.all([
      prisma.videoLike.findUnique({
        where: { userId_videoId: { userId: user.userId, videoId: id } },
      }),
      prisma.favorite.findUnique({
        where: { userId_videoId: { userId: user.userId, videoId: id } },
      }),
    ]);

    return api.success({
      liked: !!like && like.type === "LIKE",
      disliked: !!like && like.type === "DISLIKE",
      favorited: !!favorite,
      likesCount: video?.likesCount || 0,
      dislikesCount: video?.dislikesCount || 0,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Get Interactions Error]", error);
    return api.internal();
  }
}

// POST /api/videos/[id]/interactions { type: "like" | "dislike" | "favorite" }
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    const auth = await requireAuth();
    const body = await request.json();
    const type = body.type as "like" | "dislike" | "favorite";

    if (!type || !["like", "dislike", "favorite"].includes(type)) {
      return api.validation("type must be 'like', 'dislike', or 'favorite'");
    }

    if (type === "like" || type === "dislike") {
      const targetType = type === "like" ? "LIKE" : "DISLIKE";
      const existing = await prisma.videoLike.findUnique({
        where: { userId_videoId: { userId: auth.userId, videoId: id } },
      });

      // Already in this state → remove (untoggle)
      if (existing && existing.type === targetType) {
        await prisma.$transaction(async (tx) => {
          await tx.videoLike.delete({ where: { id: existing.id } });
          await tx.video.update({
            where: { id },
            data:
              targetType === "LIKE"
                ? { likesCount: { decrement: 1 } }
                : { dislikesCount: { decrement: 1 } },
          });
        });
        return api.success(
          { [type]: false, toggledOff: true },
          targetType === "LIKE" ? "Like removed" : "Dislike removed"
        );
      }

      // No row → create; other row → switch sides
      await prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.videoLike.update({
            where: { id: existing.id },
            data: { type: targetType },
          });
          await tx.video.update({
            where: { id },
            data:
              targetType === "LIKE"
                ? { likesCount: { increment: 1 }, dislikesCount: { decrement: 1 } }
                : { likesCount: { decrement: 1 }, dislikesCount: { increment: 1 } },
          });
        } else {
          await tx.videoLike.create({
            data: { userId: auth.userId, videoId: id, type: targetType },
          });
          await tx.video.update({
            where: { id },
            data:
              targetType === "LIKE"
                ? { likesCount: { increment: 1 } }
                : { dislikesCount: { increment: 1 } },
          });
        }
      });

      const video = await prisma.video.findUnique({
        where: { id },
        select: { likesCount: true, dislikesCount: true },
      });

      return api.success(
        {
          [type]: true,
          likesCount: video?.likesCount || 0,
          dislikesCount: video?.dislikesCount || 0,
        },
        targetType === "LIKE" ? "Liked" : "Disliked"
      );
    }

    // Favorite toggle
    const existing = await prisma.favorite.findUnique({
      where: { userId_videoId: { userId: auth.userId, videoId: id } },
    });

    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return api.success({ favorited: false }, "Removed from favorites");
    } else {
      await prisma.favorite.create({
        data: { userId: auth.userId, videoId: id },
      });
      return api.success({ favorited: true }, "Added to favorites");
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Toggle Interaction Error]", error);
    return api.internal();
  }
}
