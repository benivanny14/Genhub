// =============================================================================
// GENHUB - Playlist service
// Shared logic for playlists and the auto-created "Watch Later" list, so the
// routes below stay thin and the API and pages agree on the same rules.
// =============================================================================

import prisma from "@/lib/db";

export const WATCH_LATER_NAME = "Watch Later";

/** The watch-later list is implicit — created on first use, one per user. */
export async function ensureWatchLater(userId: string) {
  const existing = await prisma.playlist.findFirst({
    where: { userId, isWatchLater: true },
  });
  if (existing) return existing;

  return prisma.playlist.create({
    data: { userId, name: WATCH_LATER_NAME, isWatchLater: true },
  });
}

/** Toggle a video in Watch Later. Returns the new state + resulting size. */
export async function toggleWatchLater(userId: string, videoId: string) {
  const playlist = await ensureWatchLater(userId);

  const existing = await prisma.playlistItem.findUnique({
    where: { playlistId_videoId: { playlistId: playlist.id, videoId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.playlistItem.delete({ where: { id: existing.id } });
  } else {
    await prisma.playlistItem.create({
      data: { playlistId: playlist.id, videoId },
    });
  }

  const count = await prisma.playlistItem.count({ where: { playlistId: playlist.id } });
  return { added: !existing, count, playlistId: playlist.id };
}

export async function listPlaylists(userId: string) {
  const playlists = await prisma.playlist.findMany({
    where: { userId },
    orderBy: [{ isWatchLater: "desc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { items: true } },
      items: {
        orderBy: { createdAt: "desc" },
        take: 8,
        include: {
          video: {
            select: {
              id: true,
              title: true,
              slug: true,
              thumbnailUrl: true,
              price: true,
            },
          },
        },
      },
    },
  });

  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    isWatchLater: p.isWatchLater,
    itemCount: p._count.items,
    createdAt: p.createdAt,
    preview: p.items.map((i) => i.video),
  }));
}

/** Video ids in one user's Watch Later — used by the video page bookmark. */
export async function watchLaterIds(userId: string): Promise<string[]> {
  const playlist = await prisma.playlist.findFirst({
    where: { userId, isWatchLater: true },
    select: { id: true },
  });
  if (!playlist) return [];

  const items = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    select: { videoId: true },
  });
  return items.map((i) => i.videoId);
}
