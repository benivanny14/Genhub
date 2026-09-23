// =============================================================================
// GENHUB - Playlist items API Route
// POST   /api/playlists/[id]/items { videoId } - add a video
// DELETE /api/playlists/[id]/items?videoId=…  - remove a video
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const playlist = await prisma.playlist.findFirst({
      where: { id, userId: auth.userId },
      select: { id: true },
    });
    if (!playlist) return api.notFound("Playlist not found");

    const body = await request.json().catch(() => ({}));
    const videoId = (body?.videoId || "").toString();
    if (!videoId) return api.validation("videoId is required");

    const video = await prisma.video.findFirst({
      where: { id: videoId, isPublished: true, isDeleted: false },
      select: { id: true },
    });
    if (!video) return api.notFound("Video not found");

    const existing = await prisma.playlistItem.findUnique({
      where: { playlistId_videoId: { playlistId: playlist.id, videoId } },
      select: { id: true },
    });
    if (existing) return api.success({ added: false }, "That video is already in this playlist");

    await prisma.playlistItem.create({ data: { playlistId: playlist.id, videoId } });
    const count = await prisma.playlistItem.count({ where: { playlistId: playlist.id } });

    return api.success({ added: true, count }, "Video added to the playlist", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Playlist Add Item Error]", error);
    return api.internal();
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const playlist = await prisma.playlist.findFirst({
      where: { id, userId: auth.userId },
      select: { id: true },
    });
    if (!playlist) return api.notFound("Playlist not found");

    const videoId = request.nextUrl.searchParams.get("videoId") || "";
    if (!videoId) return api.validation("videoId is required");

    const existing = await prisma.playlistItem.findUnique({
      where: { playlistId_videoId: { playlistId: playlist.id, videoId } },
      select: { id: true },
    });
    if (!existing) return api.notFound("That video is not in this playlist");

    await prisma.playlistItem.delete({ where: { id: existing.id } });
    return api.success({ removed: true }, "Video removed from the playlist");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Playlist Remove Item Error]", error);
    return api.internal();
  }
}
