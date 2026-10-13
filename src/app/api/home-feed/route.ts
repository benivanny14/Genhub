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
import { cacheGet, cacheSet, checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { rankTrending, buildCategoryCounts, activeCreators } from "@/lib/trending";
import { firstVideoCoverByCategory } from "@/lib/services/category-cover.service";

const ROW_SIZE = 10;
const CREATOR_SIZE = 16;

/**
 * A page loads this once and caches it for a minute, so a real visitor makes
 * one call per minute. Even the busiest CDN-less deployment staying well under
 * this is the point; the limit exists so a single IP cannot drive the eleven
 * queries below on every hit *and* defeat the cache by hammering before it fills
 * (a stampede). Keyed on the IP, and generous: too tight a number on a public
 * page turns a shared NAT into an outage for everyone behind it.
 */
const FEED_MAX = 120;
const FEED_WINDOW_MS = 60_000;

const videoSelect = {
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
  creator: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, isVerified: true },
  },
} as const;

type RawVideo = {
  id: string;
  streamtapeFileId: string | null;
  price: number;
  createdAt: Date;
} & Record<string, unknown>;

function mapVideos(raw: RawVideo[]) {
  return raw.map(
    ({
      streamtapeFileId,
      previewUrl: _previewUrl,
      bunnyVideoId: _bunnyVideoId,
      teaserClipUrl: _teaserClipUrl,
      teaserBunnyVideoId: _teaserBunnyVideoId,
      price,
      createdAt,
      ...v
    }) => {
      return {
        ...v,
        price,
        createdAt: createdAt.toISOString(),
        status: typeof streamtapeFileId === "string" && streamtapeFileId.startsWith("pending_") ? "PROCESSING" : "READY",
        playable: typeof streamtapeFileId === "string" && !streamtapeFileId.startsWith("pending_"),
        encodeProgress: 0,
        teaserUrl: null,
        introUrl: null,
      };
    }
  );
}

export async function GET(request: NextRequest) {
  try {
    const { allowed } = await checkRateLimit(
      `home:${clientIp(request.headers)}`,
      FEED_MAX,
      FEED_WINDOW_MS
    );
    if (!allowed) return api.rateLimited("Too many requests — please wait a moment");

    // Bumped when Streamtape became the only public video source, so cached
    // legacy provider fields cannot leak to visitors after deployment.
    const cacheKey = "home:feed:v3";
    const cached = await cacheGet(cacheKey);
    if (cached) return api.success(cached);

    const baseWhere = {
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
      streamtapeFileId: { not: null },
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
      totalCreators,
      categoryCoversResult,
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
          username: true,
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
      // Creators who actually have something published — the same rule the
      // "Popular Creators" strip applies to its rows (activeCreators), so the
      // number in the hero and the faces under it cannot disagree. A signed-up
      // account with no videos is not a creator a visitor can go and watch, and
      // counting those would put a number in the hero that no page can back up.
      //
      // LAST in the array on purpose: the destructuring above is positional, so
      // a query inserted in the middle silently shifts every value after it
      // (which is how the category counts briefly became a number).
      prisma.user.count({
        where: {
          role: "CREATOR",
          isBanned: false,
          videos: { some: baseWhere },
        },
      }),
      // Category tile artwork: the thumbnail of the first video in each
      // category. LAST again, for the same positional reason as the count above.
      firstVideoCoverByCategory(),
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
      // categoryId -> cover image URL, and "" for the "All Videos" tile. An
      // empty object is a valid answer: a category with nothing published has no
      // cover, and the client draws a gradient instead of a stock photo.
      categoryCovers: categoryCoversResult,
      totalVideos,
      // Real counts, straight from the database. The hero used to print a
      // hardcoded "10K+ Creators · 50K+ Videos" no matter what was published,
      // which on a catalogue of one is not an optimistic estimate but a claim
      // about content that does not exist — and the first thing a visitor does
      // is look for it.
      totalCreators,
      creators: activeCreators(
        creatorsRaw.map((c) => ({
          id: c.id,
          username: c.username,
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
