// =============================================================================
// GENHUB - Publishing scheduled posts
//
// A creator who schedules a scene for 20:00 expects it to be live at 20:00. The
// row is stored `isPublished: false` with a `scheduledAt`, which the public feed
// already hides — this is the sweep that flips it when the time comes.
//
// It runs at the top of the public feed read rather than from a dedicated cron
// worker, on purpose. A missed scheduler would mean a post that never goes live,
// and the one request that must not be wrong is the one a viewer makes: by
// running the sweep there, \"is it published?\" is answered by the same request
// that lists the feed. The flip is one bounded UPDATE against an indexed column,
// so a busy feed pays almost nothing for the guarantee.
//
// Idempotent and safe to run from anywhere: two sweeps racing simply publish the
// same rows once, because the WHERE clause already excludes published rows.
// =============================================================================

import prisma from "@/lib/db";
import { cacheDel } from "@/lib/redis";

/**
 * Publish every scheduled post whose time has arrived.
 *
 * @returns how many rows went live (0 for the common case — nothing due).
 */
export async function publishDueVideos(now: Date = new Date()): Promise<number> {
  try {
    const result = await prisma.video.updateMany({
      where: {
        isPublished: false,
        isDraft: false,
        isDeleted: false,
        scheduledAt: { not: null, lte: now },
      },
      data: {
        isPublished: true,
        // Cleared so the row is no longer a candidate: without this, a sweep
        // that ran twice in a second would find it again as \"scheduled\".
        scheduledAt: null,
      },
    });

    if (result.count > 0) {
      // The feed is cached for a minute; a post that just went live must not be
      // invisible until that expires, which reads exactly like the bug this
      // feature would otherwise have.
      await cacheDel("videos:*");
    }

    return result.count;
  } catch (error) {
    // A sweep that cannot run must never fail the feed read that triggered it —
    // the post stays hidden one more request, not the whole page.
    console.error("[ScheduledPublish] sweep failed", error);
    return 0;
  }
}
