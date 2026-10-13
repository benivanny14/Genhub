// =============================================================================
// GENHUB - Subscription Feed API Route
// GET /api/subscriptions/feed - Videos from creators you subscribe to
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { videoStatus } from "@/lib/video-status";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const subs = await prisma.creatorSubscription.findMany({
      where: { viewerId: auth.userId, isActive: true, expiresAt: { gt: new Date() } },
      include: {
        creator: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const creatorIds = subs.map((s) => s.creatorId);

    const [videos, posts] = await Promise.all([
      creatorIds.length > 0          ? prisma.video.findMany({
            where: {
              creatorId: { in: creatorIds },
              isPublished: true,
              isDeleted: false,
              streamtapeFileId: { not: null },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              title: true,
              slug: true,
              thumbnailUrl: true,
              streamtapeFileId: true,
              price: true,
              teaserDuration: true,
              duration: true,
              viewsCount: true,
              likesCount: true,
              purchaseCount: true,
              category: true,
              isPremium: true,
              isFeatured: true,
              createdAt: true,
              encodingStatus: true,
              encodeProgress: true,
              creator: {
                select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
              },
            },
          })
        : [],
      // Status posts from subscribed creators (OnlyFans-style timeline)
      creatorIds.length > 0
        ? prisma.creatorPost.findMany({
            where: { creatorId: { in: creatorIds } },
            orderBy: { createdAt: "desc" },
            take: 30,
            include: {
              creator: {
                select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
              },
            },
          })
        : [],
    ]);

    return api.success({
      creators: subs.map((s) => s.creator),
      videos: videos.map(
        ({
          streamtapeFileId,
          price,
          encodingStatus,
          encodeProgress,
          ...v
        }) => {
          const status = videoStatus(encodingStatus, encodeProgress);

          return {
            ...v,
            // Destructured out only for the resolver — the client needs it back.
            price,
            status,
            encodeProgress: encodeProgress ?? 0,
            playable: status === "READY" && Boolean(streamtapeFileId),
            teaserUrl: null,
            introUrl: null,
          };
        }
      ),
      posts,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Subscription Feed Error]", error);
    return api.internal();
  }
}
