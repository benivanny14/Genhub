// =============================================================================
// GENHUB - Watch history / continue watching
// GET /api/watch-history
//
// The progress of every scene this account has started, newest first. Playback
// resume was already stored (WatchProgress, written by
// /api/videos/[id]/progress); what was missing was somewhere to SEE it — so a
// viewer who came back had to remember what they were watching.
//
// Only live rows: a scene that was unpublished or deleted since it was watched
// must not appear as a resume target, because opening it would 404.
//
// Private and per-account, so it is answered with `cache-control: no-store`.
// =============================================================================

import { requireAuth, AuthError } from "@/lib/auth";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireAuth();

    const rows = await prisma.watchProgress.findMany({
      where: { userId: auth.userId },
      orderBy: { updatedAt: "desc" },
      take: 60,
      include: {
        video: {
          select: {
            id: true,
            title: true,
            slug: true,
            thumbnailUrl: true,
            duration: true,
            price: true,
            category: true,
            isPublished: true,
            isDeleted: true,
            creator: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                isVerified: true,
              },
            },
          },
        },
      },
    });

    const items = rows
      .filter((row) => row.video && !row.video.isDeleted && row.video.isPublished)
      .map((row) => ({
        videoId: row.video.id,
        title: row.video.title,
        slug: row.video.slug,
        thumbnailUrl: row.video.thumbnailUrl,
        duration: row.video.duration,
        price: row.video.price,
        category: row.video.category,
        creator: row.video.creator,
        positionSeconds: row.positionSeconds,
        percent: row.percent,
        updatedAt: row.updatedAt.toISOString(),
      }));

    return api.privateSuccess({ items });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Watch History Error]", error);
    return api.internal();
  }
}
