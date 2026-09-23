// =============================================================================
// GENHUB - Trending & feed helpers
// Single source of truth for the smart trending score (engagement weighted by
// recency) and the small feed-shaping helpers shared by /api/home-feed,
// /api/videos and the demo-data fallback.
// =============================================================================

export interface TrendingItem {
  createdAt: string | number | Date;
  purchaseCount?: number | null;
  likesCount?: number | null;
  viewsCount?: number | null;
}

/**
 * Smart trending score:
 *   engagement = purchases×5 + likes×2 + views×0.1
 *   score      = engagement / (ageDays + 1)^1.15
 *
 * Engagement decays super-linearly with age, so a hot new video outranks an
 * older one with the same raw numbers. Videos with no engagement score 0.
 */
export function trendingScore(item: TrendingItem, now: number = Date.now()): number {
  const timestamp =
    item.createdAt instanceof Date
      ? item.createdAt.getTime()
      : new Date(item.createdAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;

  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  const engagement =
    (item.purchaseCount ?? 0) * 5 +
    (item.likesCount ?? 0) * 2 +
    (item.viewsCount ?? 0) * 0.1;

  if (engagement <= 0) return 0;
  return engagement / Math.pow(ageDays + 1, 1.15);
}

/** Returns a NEW array sorted by trending score (highest first). */
export function rankTrending<T extends TrendingItem>(
  items: T[],
  now: number = Date.now()
): T[] {
  return items
    .map((v) => ({ v, score: trendingScore(v, now) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.v);
}

/**
 * Merge a Prisma groupBy(category) result into a count map.
 * The "" key always means TOTAL videos — rows with a null category must not
 * overwrite it, otherwise "All Videos" would only count uncategorised items.
 */
export function buildCategoryCounts(
  groups: { category: string | null; count: number }[],
  totalVideos: number
): Record<string, number> {
  const counts: Record<string, number> = { "": totalVideos };
  for (const g of groups) {
    if (g.category) counts[g.category] = (counts[g.category] ?? 0) + g.count;
  }
  return counts;
}

/** Creators with zero published videos don't belong in a "Popular Creators" strip. */
export function activeCreators<T extends { videoCount: number }>(creators: T[]): T[] {
  return creators.filter((c) => c.videoCount > 0);
}
