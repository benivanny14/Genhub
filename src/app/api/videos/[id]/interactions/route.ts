// =============================================================================
// GENHUB - Video Interactions (Like / Dislike / Favorite)
// POST /api/videos/[id]/interactions - Toggle like, dislike, or favorite
// GET /api/videos/[id]/interactions - Get interaction status
//
// `[id]` is the segment the watch page was opened with, and the watch page is
// opened with the creator's SLUG whenever there is one (/video/<slug>). This
// route used to treat that segment as the video's primary key, so on every
// slugged scene the like/dislike write targeted a videoId that does not exist,
// the foreign key refused it, and the viewer saw an error toast — the buttons
// looked broken on almost every real video while working on the ones with no
// slug. It now resolves the segment the same way /api/videos/[id] does (id OR
// slug) and writes against the resolved primary key.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

/**
 * Resolve the URL segment to a real video row, by primary key or by slug.
 * Returns null when nothing matches, so the caller answers 404 instead of
 * tripping a foreign-key error on a write.
 */
async function resolveVideo(idOrSlug: string) {
  return prisma.video.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], isDeleted: false },
    select: { id: true, likesCount: true, dislikesCount: true },
  });
}

// GET /api/videos/[id]/interactions
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();

    const video = await resolveVideo(id);
    if (!video) return api.notFound("Video not found");
    const videoId = video.id;

    if (!user) {
      return api.success({
        liked: false,
        disliked: false,
        favorited: false,
        likesCount: video.likesCount || 0,
        dislikesCount: video.dislikesCount || 0,
      });
    }

    const [like, favorite] = await Promise.all([
      prisma.videoLike.findUnique({
        where: { userId_videoId: { userId: user.userId, videoId } },
      }),
      prisma.favorite.findUnique({
        where: { userId_videoId: { userId: user.userId, videoId } },
      }),
    ]);

    return api.success({
      liked: !!like && like.type === "LIKE",
      disliked: !!like && like.type === "DISLIKE",
      favorited: !!favorite,
      likesCount: video.likesCount || 0,
      dislikesCount: video.dislikesCount || 0,
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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await requireAuth();

    // A like is a write to a shared counter, so it is rate-limited per account,
    // not per IP: the vote count on a video is what its creator is judged by, and
    // a script that toggles like/dislike in a loop both inflates and corrupts it.
    const { allowed } = await checkRateLimit(
      `interaction:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many actions — please wait a moment");

    const body = await readJsonBody(request, {});
    const type = body?.type as "like" | "dislike" | "favorite";

    if (!type || !["like", "dislike", "favorite"].includes(type)) {
      return api.validation("type must be 'like', 'dislike', or 'favorite'");
    }

    // Resolve by id OR slug before any write: the watch page reaches this route
    // with whatever segment it was opened with, which is usually the slug.
    const video = await resolveVideo(id);
    if (!video) return api.notFound("Video not found");
    const videoId = video.id;

    if (type === "like" || type === "dislike") {
      const targetType = type === "like" ? "LIKE" : "DISLIKE";
      const existing = await prisma.videoLike.findUnique({
        where: { userId_videoId: { userId: auth.userId, videoId } },
      });

      // Already in this state → remove (untoggle)
      if (existing && existing.type === targetType) {
        await prisma.$transaction(async (tx) => {
          await tx.videoLike.delete({ where: { id: existing.id } });
          await tx.video.update({
            where: { id: videoId },
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
            where: { id: videoId },
            data:
              targetType === "LIKE"
                ? { likesCount: { increment: 1 }, dislikesCount: { decrement: 1 } }
                : { likesCount: { decrement: 1 }, dislikesCount: { increment: 1 } },
          });
        } else {
          await tx.videoLike.create({
            data: { userId: auth.userId, videoId, type: targetType },
          });
          await tx.video.update({
            where: { id: videoId },
            data:
              targetType === "LIKE"
                ? { likesCount: { increment: 1 } }
                : { dislikesCount: { increment: 1 } },
          });
        }
      });

      const updated = await prisma.video.findUnique({
        where: { id: videoId },
        select: { likesCount: true, dislikesCount: true },
      });

      return api.success(
        {
          [type]: true,
          likesCount: updated?.likesCount || 0,
          dislikesCount: updated?.dislikesCount || 0,
        },
        targetType === "LIKE" ? "Liked" : "Disliked"
      );
    }

    // Favorite toggle
    const existing = await prisma.favorite.findUnique({
      where: { userId_videoId: { userId: auth.userId, videoId } },
    });

    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return api.success({ favorited: false }, "Removed from favorites");
    } else {
      await prisma.favorite.create({
        data: { userId: auth.userId, videoId },
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
