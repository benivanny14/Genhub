// =============================================================================
// GENHUB - Category covers
//
// A category's cover is the thumbnail of the FIRST video published into it, not
// a generated placeholder.
//
// The registry used to hand every category a deterministic picsum seed, so
// /browse/lesbian advertised a stock photo with no relationship to anything on
// the site — and two categories could never look more or less alive than each
// other. The first video in a category is the honest answer to "what does this
// category look like?": it is real, it changes as creators publish, and an empty
// category has no cover rather than a lie. The pages fall back to a gradient
// when this returns nothing.
//
// "First" means OLDEST by createdAt — the video that opened the category — not
// the newest. Re-basing it on the newest would make every browse page shuffle
// with each upload, which is exactly the churn a stable cover avoids.
// =============================================================================

import prisma from "@/lib/db";

/** Only what a visitor can actually open: published, not deleted, not flagged. */
const COVERABLE = {
  isPublished: true,
  isDeleted: false,
  isFlagged: false,
} as const;

/**
 * Cover URL for every category that has one, keyed by the category id stored on
 * Video.category. The "" key is the "all" pseudo-category — the first video
 * overall, which is what the "All Videos" tile shows.
 *
 * One query. `distinct: ["category"]` with an ascending orderBy lets Postgres
 * answer "the earliest row per category" in a single pass instead of one query
 * per category.
 */
export async function firstVideoCoverByCategory(): Promise<Record<string, string>> {
  const rows = await prisma.video.findMany({
    where: { ...COVERABLE, thumbnailUrl: { not: null } },
    orderBy: { createdAt: "asc" },
    distinct: ["category"],
    select: { category: true, thumbnailUrl: true },
  });

  const covers: Record<string, string> = {};
  for (const row of rows) {
    if (!row.thumbnailUrl) continue;
    covers[row.category ?? ""] = row.thumbnailUrl;
  }

  // The "all" tile is the site's front door, so it takes the earliest video
  // overall — even though that row already answers for its own category above.
  const first = rows[0]?.thumbnailUrl;
  if (first) covers[""] = first;

  return covers;
}

/**
 * The cover for one category, or null when nothing publishable in it has a
 * thumbnail. "all" and "" both mean "no category filter".
 */
export async function firstVideoCover(categoryId: string): Promise<string | null> {
  const video = await prisma.video.findFirst({
    where: {
      ...COVERABLE,
      ...(categoryId && categoryId !== "all" ? { category: categoryId } : {}),
      thumbnailUrl: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: { thumbnailUrl: true },
  });

  return video?.thumbnailUrl ?? null;
}
