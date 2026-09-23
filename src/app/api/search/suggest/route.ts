// =============================================================================
// GENHUB - Search Suggestions API Route
// GET /api/search/suggest?q= - Autocomplete: videos + creators + tags
//
// Public, and it runs three queries (one of which scans up to 300 videos) per
// UNIQUE query string, keyed in the cache by the attacker-controlled `q`.
// Unlimited and unauthenticated, that is a cheap way to drive unbounded
// database load and to fill Redis with one-off keys — the cache only helps
// when the same string repeats, which is exactly what an attacker avoids.
// Limited per IP well above what typing generates.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { cacheGet, cacheSet, checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";

export async function GET(request: NextRequest) {
  try {
    const { allowed } = await checkRateLimit(
      `suggest:${clientIp(request.headers)}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many suggestions — please wait a moment");

    const q = request.nextUrl.searchParams.get("q")?.trim() || "";
    if (q.length < 2) return api.success({ videos: [], creators: [], tags: [] });

    const cacheKey = `search:suggest:${q.toLowerCase()}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return api.success(cached);

    const [videos, creators] = await Promise.all([
      prisma.video.findMany({
        where: {
          isPublished: true,
          isDeleted: false,
          isFlagged: false,
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { tags: { has: q.toLowerCase() } },
          ],
        },
        orderBy: { viewsCount: "desc" },
        take: 5,
        select: { id: true, title: true, slug: true, thumbnailUrl: true, price: true },
      }),
      prisma.user.findMany({
        where: {
          role: "CREATOR",
          isBanned: false,
          displayName: { contains: q, mode: "insensitive" },
        },
        orderBy: { isVerified: "desc" },
        take: 4,
        select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
      }),
    ]);

    // Suggest popular tags matching the query
    const tagMatches = new Set<string>();
    if (videos.length < 5) {
      const tagged = await prisma.video.findMany({
        where: { isPublished: true, isDeleted: false },
        select: { tags: true },
        take: 300,
      });
      for (const v of tagged) {
        for (const t of v.tags) {
          if (t.toLowerCase().includes(q.toLowerCase())) tagMatches.add(t);
          if (tagMatches.size >= 6) break;
        }
        if (tagMatches.size >= 6) break;
      }
    }

    const result = {
      videos,
      creators,
      tags: Array.from(tagMatches),
    };

    await cacheSet(cacheKey, result, 120);
    return api.success(result);
  } catch (error) {
    console.error("[Search Suggest Error]", error);
    return api.internal();
  }
}
