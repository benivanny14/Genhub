// =============================================================================
// GENHUB - Subscription Feed API Route
// GET /api/subscriptions/feed - Videos from creators you subscribe to
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { resolveTeaserUrl } from "@/lib/bunny";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const subs = await prisma.creatorSubscription.findMany({
      where: { viewerId: auth.userId, isActive: true, expiresAt: { gt: new Date() } },
      include: {
        creator: {
          select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const creatorIds = subs.map((s) => s.creatorId);

    const [videos, posts] = await Promise.all([
      creatorIds.length > 0
        ? prisma.video.findMany({
            where: {
              creatorId: { in: creatorIds },
              isPublished: true,
              isDeleted: false,
            },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              title: true,
              slug: true,
              thumbnailUrl: true,
              previewUrl: true,
              bunnyVideoId: true,
              teaserBunnyVideoId: true,
              teaserClipUrl: true,
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
              creator: {
                select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
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
                select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
              },
            },
          })
        : [],
    ]);

    return api.success({
      creators: subs.map((s) => s.creator),
      // Bunny-hosted rows previously got `teaserUrl: previewUrl` regardless,
      // so a subscriber's feed had no teaser at all for them.
      videos: videos.map(
        ({ previewUrl, bunnyVideoId, teaserBunnyVideoId, teaserClipUrl, price, ...v }) => ({
          ...v,
          // Destructured out only for the resolver — the client needs it back.
          price,
          teaserUrl: resolveTeaserUrl({
            bunnyVideoId,
            previewUrl,
            teaserBunnyVideoId,
            teaserClipUrl,
            price,
          }),
        })
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
