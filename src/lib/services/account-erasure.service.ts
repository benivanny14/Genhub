// =============================================================================
// GENHUB - Erasing an account
// =============================================================================
//
// "Delete my account" has to mean the account is gone — not a flag that hides it
// while the row, the videos, the identity documents and the messages stay on
// disk. That is what this module does, and the parts are in a specific order for
// a reason:
//
//   1. Read everything that identifies files (video ids, thumbnail keys, the KYC
//      keys). Once the rows are gone there is nothing left to clean up with.
//   2. Delete the remote media — Bunny videos, the private document tree, the
//      avatar, the thumbnails. Best effort, and reported: a Bunny outage must not
//      trap somebody in an account they asked to leave.
//   3. Delete the database rows in dependency order, in ONE transaction. Prisma
//      only cascades where the schema says `onDelete: Cascade`; the rest
//      (a user's videos, their transactions, the reports they filed, the
//      messages they sent) hold a required foreign key and would abort the whole
//      delete with a constraint error.
//
// The job is idempotent-ish by construction: it is a sequence of deleteMany
// calls, so a retry after a partial failure finishes the rest rather than
// complaining about what is already missing.
//
// One refusal is deliberate: an admin cannot erase the last admin account. Doing
// so would leave the deployment with nobody able to reach /admin, which is a much
// bigger problem than the one the person was trying to solve.

import prisma from "@/lib/db";
import config from "@/lib/config";
import { deleteBunnyVideo, isBunnyVideoId } from "@/lib/bunny";
import { BUNNY_STORAGE_ORIGIN, mediaKeyFromUrl, mediaKindOf } from "@/lib/media";

export interface ErasureReport {
  /** Rows removed per table — the receipt the user is shown. */
  removed: Record<string, number>;
  /** Remote media that could not be removed. Surfaced, never hidden. */
  failures: string[];
  /** Videos Bunny was asked to delete. */
  videosRemoved: number;
}

const STORAGE_TIMEOUT_MS = 15_000;

async function storageDelete(key: string): Promise<boolean> {
  if (!config.bunny.storageZone || !config.bunny.storageAccessKey) return false;
  try {
    const res = await fetch(`${BUNNY_STORAGE_ORIGIN}/${config.bunny.storageZone}/${key}`, {
      method: "DELETE",
      headers: { AccessKey: config.bunny.storageAccessKey },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** Every object name under a storage prefix, one level at a time. */
async function listStorageKeys(prefix: string): Promise<string[]> {
  if (!config.bunny.storageZone || !config.bunny.storageAccessKey) return [];
  const keys: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    try {
      const res = await fetch(
        `${BUNNY_STORAGE_ORIGIN}/${config.bunny.storageZone}/${dir}`,
        {
          headers: {
            AccessKey: config.bunny.storageAccessKey as string,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
        }
      );
      if (!res.ok) return;
      const entries = (await res.json()) as { ObjectName?: string; IsDirectory?: boolean }[];
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry.ObjectName) continue;
        const next = `${dir}${dir.endsWith("/") ? "" : "/"}${entry.ObjectName}`;
        if (entry.IsDirectory) await walk(`${next}/`, depth + 1);
        else keys.push(next);
      }
    } catch {
      // A listing that fails leaves orphan files, not a broken account. The
      // database part still has to happen.
    }
  };
  await walk(prefix.endsWith("/") ? prefix : `${prefix}/`, 0);
  return keys;
}

/**
 * Is deleting this user allowed?
 *
 * Only one rule, and it is about the deployment rather than the person: the last
 * admin cannot leave, because nobody would be left who can approve creators,
 * release payouts or reach /admin at all.
 */
export async function canEraseAccount(
  userId: string,
  role: string
): Promise<{ allowed: boolean; reason?: string }> {
  if (role !== "ADMIN") return { allowed: true };

  const admins = await prisma.user.count({ where: { role: "ADMIN" } });
  if (admins <= 1) {
    return {
      allowed: false,
      reason:
        "You are the only admin, and the site needs one to approve creators and release payouts. " +
        "Make another account an admin first, then delete this one.",
    };
  }
  return { allowed: true };
}

export async function eraseAccount(userId: string): Promise<ErasureReport> {
  const failures: string[] = [];
  const removed: Record<string, number> = {};

  // --- 1. Everything that points at a file -----------------------------------
  const [user, videos] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    }),
    prisma.video.findMany({
      where: { creatorId: userId },
      select: { id: true, title: true, bunnyVideoId: true, thumbnailUrl: true },
    }),
  ]);

  const videoIds = videos.map((v) => v.id);
  const storageKeys = new Set<string>();

  const avatarKey = mediaKeyFromUrl(user?.avatarUrl, config.bunny.cdnHostname);
  if (avatarKey) storageKeys.add(avatarKey);

  for (const video of videos) {
    const key = mediaKeyFromUrl(video.thumbnailUrl, config.bunny.cdnHostname);
    if (key) storageKeys.add(key);
  }

  // Identity documents are stored per owner, so the whole folder goes — including
  // any object whose row has since been superseded.
  for (const key of await listStorageKeys(`private/${userId}`)) storageKeys.add(key);

  // --- 2. Remote media --------------------------------------------------------
  let videosRemoved = 0;
  for (const video of videos) {
    if (!isBunnyVideoId(video.bunnyVideoId) || !config.bunny.apiKey) continue;
    try {
      await deleteBunnyVideo(video.bunnyVideoId);
      videosRemoved++;
    } catch (error) {
      failures.push(`video "${video.title}": ${(error as Error)?.message || error}`);
    }
  }

  for (const key of Array.from(storageKeys)) {
    // Never a key that is not this user's: `private/` keys carry the owner id, so
    // a row pointing at somebody else's document must not turn "delete my
    // account" into a way to destroy their file. The refusal is REPORTED rather
    // than skipped — the user was promised their documents are gone, and a file
    // we declined to touch is exactly the kind of leftover they need to hear
    // about instead of discovering later.
    if (mediaKindOf(key) === "private" && !key.startsWith(`private/${userId}/`)) {
      failures.push(
        `refused to delete ${key} - it belongs to another account (is the data corrupt?)`
      );
      continue;
    }
    const ok = await storageDelete(key);
    if (!ok) failures.push(`file ${key} could not be removed`);
  }

  // --- 3. Rows ----------------------------------------------------------------
  await prisma.$transaction(async (tx) => {
    // Reports: those filed by this user, and those filed against their videos.
    // `VideoReport.video` has no cascade, so it is also what would otherwise block
    // the video delete below with a foreign-key error.
    removed.reports = (
      await tx.videoReport.deleteMany({
        where: { OR: [{ reporterId: userId }, { videoId: { in: videoIds } }] },
      })
    ).count;

    // Videos, then their transactions' pointers. `Transaction.videoId` is
    // optional, so it nulls itself — but the buyer's purchase record is theirs to
    // keep, so it is NOT deleted here.
    removed.videos = (
      await tx.video.deleteMany({ where: { creatorId: userId } })
    ).count;

    // Money this user paid. Their own purchase history goes with them.
    removed.transactions = (
      await tx.transaction.deleteMany({ where: { userId } })
    ).count;
    // Money owed TO them: the buyer's receipt stays, the creator link is cut.
    removed.detachedEarnings = (
      await tx.transaction.updateMany({
        where: { creatorId: userId },
        data: { creatorId: null },
      })
    ).count;

    removed.payouts = (
      await tx.payoutRequest.deleteMany({ where: { creatorId: userId } })
    ).count;
    // Reviews and resolutions this user performed as an admin: keep the record,
    // drop the name.
    removed.kycReviews = (
      await tx.kycVerification.updateMany({
        where: { reviewedBy: userId },
        data: { reviewedBy: null },
      })
    ).count;
    removed.resolvedReports = (
      await tx.videoReport.updateMany({
        where: { resolvedBy: userId },
        data: { resolvedBy: null },
      })
    ).count;
    removed.processedPayouts = (
      await tx.payoutRequest.updateMany({
        where: { processedBy: userId },
        data: { processedBy: null },
      })
    ).count;

    // Messages have a required sender and receiver, so they cannot outlive either
    // party.
    removed.messages = (
      await tx.payMessage.deleteMany({
        where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      })
    ).count;

    // Anyone this user referred keeps their account, without the referrer.
    removed.referrals = (
      await tx.user.updateMany({
        where: { referredById: userId },
        data: { referredById: null },
      })
    ).count;

    // Everything else — videos watched, likes, favorites, playlists, watch
    // progress, notifications, KYC submissions, sessions, the creator profile —
    // is declared `onDelete: Cascade` on the schema and goes with this row.
    removed.account = (await tx.user.deleteMany({ where: { id: userId } })).count;
  });

  return { removed, failures, videosRemoved };
}
