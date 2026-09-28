// =============================================================================
// GENHUB - Creator Directory API Route
// GET /api/creators - Public A-Z creator directory with search
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { cacheGet, cacheSet } from "@/lib/redis";
import { intParam } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    const search = request.nextUrl.searchParams.get("q")?.trim() || "";
    // Same guard as the feed: `Math.max(1, NaN)` is NaN, and Prisma refuses a
    // NaN `skip`/`take` with a 500.
    const page = intParam(request.nextUrl.searchParams.get("page"), 1);
    const limit = intParam(request.nextUrl.searchParams.get("limit"), 24, 60);

    const cacheKey = `creators:dir:${search}:${page}:${limit}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return api.success(cached);

    const where = {
      role: "CREATOR" as const,
      isBanned: false,
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: "insensitive" as const } },
              // The handle is how people quote a creator (@name), so it has to
              // find them too — and it is the only name that is unique.
              { username: { contains: search, mode: "insensitive" as const } },
              { creatorProfile: { bio: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    };

    const total = await prisma.user.count({ where });

    const creators = await prisma.user.findMany({
      where,
      orderBy: [{ isVerified: "desc" }, { displayName: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        isVerified: true,
        createdAt: true,
        creatorProfile: { select: { bio: true, subscriptionPrice: true, totalSubscribers: true } },
        _count: {
          select: {
            videos: { where: { isPublished: true, isDeleted: false } },
            subscriberOf: { where: { isActive: true, expiresAt: { gt: new Date() } } },
          },
        },
      },
    });

    const result = {
      creators,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };

    await cacheSet(cacheKey, result, 120);
    return api.success(result);
  } catch (error) {
    console.error("[Creator Directory Error]", error);
    return api.internal();
  }
}
