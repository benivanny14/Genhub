// =============================================================================
// GENHUB - Subscription Feed API Route
// GET /api/subscriptions/feed - Videos from creators you subscribe to
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { introClipPath, resolveTeaserUrl } from "@/lib/bunny";
import { BUNNY_FAILED, videoStatus } from "@/lib/video-status";

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
              // Published the moment the upload lands (see /api/videos POST), so
              // a subscribed creator's newest post shows up here straight away
              // behind its "Inachakatwa..." badge. One whose encode FAILED is a
              // post that can never play, so it is not in the timeline; the
              // creator sees it on their own dashboard instead.
              OR: [{ encodingStatus: null }, { encodingStatus: { not: BUNNY_FAILED } }],
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
              // Read to answer "can this play?" and then replaced below by the
              // single derived `status`, so a card has one thing to switch on
              // and the raw Bunny codes never reach the browser.
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
      // Bunny-hosted rows previously got `teaserUrl: previewUrl` regardless,
      // so a subscriber's feed had no teaser at all for them.
      videos: videos.map(
        ({
          previewUrl,
          bunnyVideoId,
          teaserBunnyVideoId,
          teaserClipUrl,
          price,
          encodingStatus,
          encodeProgress,
          ...v
        }) => {
          // `id` is the row id: a Bunny-hosted trailer is served through
          // /api/videos/<rowId>/stream so its manifest can be rewritten rather
          // than handed to a player that cannot authorise its segments.
          const teaserUrl = resolveTeaserUrl({
            id: v.id,
            bunnyVideoId,
            previewUrl,
            teaserBunnyVideoId,
            teaserClipUrl,
            price,
          });

          // Same derivation the public feed uses — one rule, two routes.
          const status = videoStatus(encodingStatus, encodeProgress);

          return {
            ...v,
            // Destructured out only for the resolver — the client needs it back.
            price,
            status,
            encodeProgress: encodeProgress ?? 0,
            // False while Bunny is still transcoding, so the card shows a poster
            // and a badge instead of hovering a manifest that 404s.
            playable: status === "READY",
            teaserUrl,
            // A subscription covers a creator's whole catalogue, but a feed also
            // carries scenes the viewer has NOT unlocked, and those are the ones
            // whose cards need something to show on hover.
            introUrl: teaserUrl ? null : introClipPath({ id: v.id, bunnyVideoId }),
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
