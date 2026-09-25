// =============================================================================
// GENHUB - Videos API Route
// GET /api/videos - List published videos (feed)
// POST /api/videos - Create a new video (creator only)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { createVideoSchema } from "@/lib/validation";
import { generateSlug } from "@/lib/utils";
import { isBunnyConfigured, isBunnyVideoId, resolveTeaserUrl } from "@/lib/bunny";
import { cacheGet, cacheSet } from "@/lib/redis";
import { rankTrending, type TrendingItem } from "@/lib/trending";
import { normalizeMediaUrl } from "@/lib/media";
import config from "@/lib/config";

// =============================================================================
// GET /api/videos - Public feed with optional search
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));
    const search = searchParams.get("q") || "";
    const category = searchParams.get("category") || "";
    // A creator's own page asks for their videos with this. It used to be read
    // and ignored — the parameter was never put in the WHERE clause, so
    // /creator/<id> rendered the entire site feed under "Videos by <name>", and
    // the SEO shell said N published videos while the grid showed everyone's.
    const creatorId = searchParams.get("creatorId") || "";
    const sortBy = searchParams.get("sort") || "newest";
    const durationFilter = searchParams.get("duration") || ""; // short | medium | long
    const dateFilter = searchParams.get("date") || ""; // day | week | month | year

    // creatorId belongs in the key: without it one creator's page would be
    // served the cached general feed, and the bug above would survive the fix.
    const cacheKey = `videos:list:${page}:${limit}:${search}:${category}:${sortBy}:${durationFilter}:${dateFilter}:${creatorId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return api.success(cached);
    }

    const where = {
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" as const } },
              { description: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(category ? { category } : {}),
      ...(creatorId ? { creatorId } : {}),
      ...(durationFilter
        ? {
            duration:
              durationFilter === "short"
                ? { lt: 300 }
                : durationFilter === "medium"
                ? { gte: 300, lt: 1200 }
                : { gte: 1200 },
          }
        : {}),
      ...(dateFilter
        ? {
            createdAt: {
              gte: new Date(
                Date.now() -
                  ({ day: 1, week: 7, month: 30, year: 365 }[dateFilter] || 365) *
                    86400000
              ),
            },
          }
        : {}),
    };

    const orderBy =
      sortBy === "popular"
        ? { viewsCount: "desc" as const }
        : sortBy === "rated"
          ? { likesCount: "desc" as const }
          : sortBy === "price_low"
          ? { price: "asc" as const }
          : sortBy === "price_high"
            ? { price: "desc" as const }
            : sortBy === "featured"
              ? { isFeatured: "desc" as const }
              : { createdAt: "desc" as const };

    const videoSelect = {
      id: true,
      title: true,
      slug: true,
      description: true,
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
      tags: true,
      createdAt: true,
      creator: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
    } as const;

    const total = await prisma.video.count({ where });

    let videos: Record<string, unknown>[];

    if (sortBy === "trending") {
      // Smart trending: engagement weighted by recency (shared lib/trending.ts)
      const pool = await prisma.video.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
        select: videoSelect,
      });
      videos = rankTrending(pool as unknown as TrendingItem[]).slice(
        (page - 1) * limit,
        page * limit
      ) as unknown as Record<string, unknown>[];
    } else {
      videos = (await prisma.video.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        select: videoSelect,
      })) as Record<string, unknown>[];
    }

    const result = {
      videos: (
        videos as unknown as {
          id: string;
          bunnyVideoId: string;
          previewUrl: string | null;
          teaserBunnyVideoId: string | null;
          teaserClipUrl: string | null;
          price: number;
        }[]
      ).map(
        ({ bunnyVideoId, previewUrl, teaserBunnyVideoId, teaserClipUrl, price, ...v }) => ({
          ...v,
          // Destructured out only for the resolver — the client needs it back,
          // or every card loses its price badge.
          price,
          // The trailer clip when one exists, the video itself when it is free,
          // and null for a paid scene with no trailer — never a throw, so one
          // video with a Bunny id on an unconfigured library cannot break the feed.
          // `id` is the row id: a Bunny-hosted trailer is served through
          // /api/videos/<rowId>/stream so its manifest can be rewritten rather
          // than handed to a player that cannot authorise its segments.
          teaserUrl: resolveTeaserUrl({
            id: v.id,
            bunnyVideoId,
            previewUrl,
            teaserBunnyVideoId,
            teaserClipUrl,
            price,
          }),
        })
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    await cacheSet(cacheKey, result, 60); // Cache 1 minute
    return api.success(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[List Videos Error]", error);
    return api.internal();
  }
}

// =============================================================================
// POST /api/videos - Create video (Creator only)
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Check KYC
    if (auth.role !== "ADMIN") {
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { kycStatus: true, isBanned: true },
      });

      if (!user || user.kycStatus !== "APPROVED") {
        return api.forbidden(
          "You must complete KYC before uploading videos"
        );
      }

      if (user.isBanned) {
        return api.forbidden("Your account is blocked");
      }
    }

    const body = await request.json();
    const result = createVideoSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const {
      title,
      description,
      price,
      teaserDuration,
      category,
      tags,
      bunnyVideoId,
      teaserBunnyVideoId,
      thumbnailUrl,
    } = result.data;

    const slug = generateSlug(title);

    // Bunny accepts an upload seconds after the creator's browser starts
    // sending, but the video is unplayable until transcoding finishes. A video
    // Bunny has to transcode therefore starts UNPUBLISHED and is published by
    // refreshVideoEncoding() the moment Bunny can serve it — the creator is
    // notified at the same time. Side-loaded/demo rows (synthetic ids, which
    // Bunny never transcodes) keep publishing immediately, exactly as before.
    const awaitingTranscode = isBunnyConfigured() && isBunnyVideoId(bunnyVideoId);

    const video = await prisma.video.create({
      data: {
        creatorId: auth.userId,
        title,
        description,
        slug,
        bunnyVideoId,
        teaserBunnyVideoId: teaserBunnyVideoId ?? null,
        // Healed on write: a creator pasting the old Bunny CDN URL (or a value
        // copied from an older video) is stored as /api/media/<key> instead, so
        // the site never again publishes a link that 403s.
        thumbnailUrl: normalizeMediaUrl(thumbnailUrl, config.bunny.cdnHostname),

        price,
        teaserDuration,
        category,
        tags: tags || [],
        isPublished: !awaitingTranscode,
        encodingStatus: awaitingTranscode ? 0 : null,
        // createVideoSchema guarantees this is true (18 U.S.C. § 2257)
        complianceAttestedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        bunnyVideoId: true,
        price: true,
        isPublished: true,
        encodingStatus: true,
        createdAt: true,
      },
    });

    return api.success(
      video,
      awaitingTranscode
        ? "Video saved — it goes live automatically as soon as processing finishes"
        : "Video created successfully",
      201
    );
  } catch (error: any) {
    console.error("[Create Video Error]", error);
    if (error.message?.includes("Insufficient")) {
      return api.forbidden(error.message);
    }
    return api.internal();
  }
}
