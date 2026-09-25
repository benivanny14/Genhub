// =============================================================================
// GENHUB - Home Feed API Route
// GET /api/home-feed - Everything the front page needs in ONE request:
//   featured hero video, category counts, curated video rows
//   (new / popular / trending / rated / free) and the creator strip.
// Cached for 60s. Falls back to an empty payload the client fills with demo data.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { cacheGet, cacheSet } from "@/lib/redis";
import { resolveTeaserUrl } from "@/lib/bunny";
import { rankTrending, buildCategoryCounts, activeCreators } from "@/lib/trending";

const ROW_SIZE = 10;
const CREATOR_SIZE = 16;

const videoSelect = {
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
} as const;

type RawVideo = {
  id: string;
  previewUrl: string | null;
  bunnyVideoId: string;
  teaserBunnyVideoId: string | null;
  teaserClipUrl: string | null;
  price: number;
  createdAt: Date;
} & Record<string, unknown>;

// Demo streams are attached to previewUrl at seed time; Bunny-hosted rows get a
// signed teaser instead — mirror /api/videos' teaserUrl contract.
//
// This used to build the URL by hand:
//   `https://vz-${id}.b-cdn.net/playback.m3u8`
// which could never work — it was unsigned (Token Authentication rejects it),
// the hostname ignored the configured BUNNY_CDN_HOSTNAME pull zone, and Bunny's
// manifest is `playlist.m3u8`, not `playback.m3u8`. Every hover preview on the
// home page for a Bunny-hosted video was therefore dead. resolved through the
// same helper as every other route so the shape cannot drift again.
function mapVideos(raw: RawVideo[]) {
  return raw.map(
    ({ previewUrl, bunnyVideoId, teaserBunnyVideoId, teaserClipUrl, price, createdAt, ...v }) => ({
      ...v,
      // `price` is destructured out only so the teaser resolver can see it — it
      // must go back on the response, or every card loses its price badge and
      // the UI cannot tell a free scene from a paid one.
      price,
      createdAt: createdAt.toISOString(),
      // `id` is the row id, and the resolver needs it: a Bunny-hosted trailer is
      // served through /api/videos/<rowId>/stream so its manifest can be
      // rewritten (see lib/hls.ts) instead of handed over unusable.
      teaserUrl: resolveTeaserUrl({
        id: v.id,
        bunnyVideoId,
        previewUrl,
        teaserBunnyVideoId,
        teaserClipUrl,
        price,
      }),
    })
  );
}

export async function GET(_request: NextRequest) {
  try {
    const cacheKey = "home:feed:v1";
    const cached = await cacheGet(cacheKey);
    if (cached) return api.success(cached);

    const baseWhere = {
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
    } as const;

    const [
      featuredRaw,
      newRaw,
      popularRaw,
      ratedRaw,
      freeRaw,
      trendingRaw,
      groupCounts,
      totalVideos,
      creatorsRaw,
    ] = await Promise.all([
      // Hero: newest featured video
      prisma.video.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { ...videoSelect, isFeatured: true },
      }),
      prisma.video.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        take: ROW_SIZE,
        select: videoSelect,
      }),
      prisma.video.findMany({
        where: baseWhere,
        orderBy: { viewsCount: "desc" },
        take: ROW_SIZE,
        select: videoSelect,
      }),
      prisma.video.findMany({
        where: baseWhere,
        orderBy: { likesCount: "desc" },
        take: ROW_SIZE,
        select: videoSelect,
      }),
      prisma.video.findMany({
        where: { ...baseWhere, price: 0 },
        orderBy: { viewsCount: "desc" },
        take: ROW_SIZE,
        select: videoSelect,
      }),
      // Smart trending: engagement weighted by recency (same score as /api/videos)
      prisma.video.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        take: 200,
        select: videoSelect,
      }),
      prisma.video.groupBy({
        by: ["category"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.video.count({ where: baseWhere }),
      prisma.user.findMany({
        where: { role: "CREATOR", isBanned: false },
        orderBy: [{ isVerified: "desc" }, { displayName: "asc" }],
        take: CREATOR_SIZE,
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
          _count: {
            select: {
              videos: { where: { isPublished: true, isDeleted: false, isFlagged: false } },
            },
          },
        },
      }),
    ]);

    const now = Date.now();
    const trending = rankTrending(
      trendingRaw as unknown as (RawVideo & {
        purchaseCount: number;
        likesCount: number;
        viewsCount: number;
      })[],
      now
    ).slice(0, ROW_SIZE);

    const counts = buildCategoryCounts(
      groupCounts.map((g) => ({ category: g.category, count: g._count._all })),
      totalVideos
    );

    const result = {
      featured: mapVideos(featuredRaw as unknown as RawVideo[])[0] || null,
      rows: {
        new: mapVideos(newRaw as unknown as RawVideo[]),
        popular: mapVideos(popularRaw as unknown as RawVideo[]),
        rated: mapVideos(ratedRaw as unknown as RawVideo[]),
        free: mapVideos(freeRaw as unknown as RawVideo[]),
        trending: mapVideos(trending as unknown as RawVideo[]),
      },
      categories: counts,
      totalVideos,
      creators: activeCreators(
        creatorsRaw.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          avatarUrl: c.avatarUrl,
          isVerified: c.isVerified,
          videoCount: c._count.videos,
        }))
      ),
    };

    await cacheSet(cacheKey, result, 60);
    return api.success(result);
  } catch (error) {
    console.error("[Home Feed Error]", error);
    return api.internal();
  }
}
