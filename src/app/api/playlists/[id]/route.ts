// =============================================================================
// GENHUB - Playlist detail API Route
// GET    /api/playlists/[id] - playlist with all its videos
// PATCH  /api/playlists/[id] - rename { name }
// DELETE /api/playlists/[id] - delete (Watch Later cannot be deleted)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

async function ownedPlaylist(id: string, userId: string) {
  return prisma.playlist.findFirst({ where: { id, userId } });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const playlist = await prisma.playlist.findFirst({
      where: { id, userId: auth.userId },
      include: {
        items: {
          orderBy: { createdAt: "desc" },
          include: {
            video: {
              include: {
                creator: { select: { id: true, displayName: true, avatarUrl: true } },
              },
            },
          },
        },
      },
    });

    if (!playlist) return api.notFound("Playlist not found");

    const items = playlist.items
      .filter((i) => i.video && i.video.isPublished && !i.video.isDeleted)
      .map((i) => ({ itemId: i.id, addedAt: i.createdAt, ...i.video }));

    return api.success({
      id: playlist.id,
      name: playlist.name,
      isWatchLater: playlist.isWatchLater,
      itemCount: items.length,
      videos: items,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Playlist Detail Error]", error);
    return api.internal();
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const playlist = await ownedPlaylist(id, auth.userId);
    if (!playlist) return api.notFound("Playlist not found");
    if (playlist.isWatchLater) return api.error("Watch Later cannot be renamed", 409, "SYSTEM_LIST");

    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 2) return api.validation("A playlist name must be at least 2 characters");

    const updated = await prisma.playlist.update({
      where: { id: playlist.id },
      data: { name },
      select: { id: true, name: true, isWatchLater: true },
    });

    return api.success(updated, "Playlist updated");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Rename Playlist Error]", error);
    return api.internal();
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const playlist = await ownedPlaylist(id, auth.userId);
    if (!playlist) return api.notFound("Playlist not found");
    if (playlist.isWatchLater) return api.error("Watch Later cannot be deleted", 409, "SYSTEM_LIST");

    await prisma.playlist.delete({ where: { id: playlist.id } });
    return api.success(null, "Playlist deleted");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Delete Playlist Error]", error);
    return api.internal();
  }
}
