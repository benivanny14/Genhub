// =============================================================================
// GENHUB - sitemap.xml
// Static marketing pages + every /browse/[category] page, plus dynamic creator
// profiles and public video pages pulled from the DB (falls back to the static
// portion if the database is unreachable so the sitemap never 500s).
// =============================================================================

import type { MetadataRoute } from "next";
import config from "@/lib/config";
import { CATEGORIES, categoryHref } from "@/lib/categories";
import prisma from "@/lib/db";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config.appUrl.replace(/\/$/, "");
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: base, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/creators`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/trending`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/most-viewed`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/top-rated`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/become-creator`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/faq`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/support`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/dmca`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/2257`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  const categoryPages: MetadataRoute.Sitemap = CATEGORIES.map((c) => ({
    url: `${base}${categoryHref(c.id)}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.8,
  }));

  let creatorPages: MetadataRoute.Sitemap = [];
  let videoPages: MetadataRoute.Sitemap = [];

  try {
    const [creators, videos] = await Promise.all([
      prisma.user.findMany({
        where: { role: "CREATOR", isBanned: false },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1000,
      }),
      prisma.video.findMany({
        where: { isPublished: true, isDeleted: false, isFlagged: false },
        select: { id: true, slug: true, updatedAt: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      }),
    ]);

    creatorPages = creators.map((c) => ({
      url: `${base}/creator/${c.id}`,
      lastModified: c.updatedAt,
      changeFrequency: "weekly",
      priority: 0.6,
    }));

    videoPages = videos.map((v) => ({
      url: `${base}/video/${v.slug || v.id}`,
      lastModified: v.updatedAt,
      changeFrequency: "weekly",
      priority: 0.7,
    }));
  } catch {
    // DB offline — serve the static portion rather than failing the sitemap
  }

  return [...staticPages, ...categoryPages, ...creatorPages, ...videoPages];
}
