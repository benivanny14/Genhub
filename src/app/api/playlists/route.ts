// =============================================================================
// GENHUB - Playlists API Route
// GET  /api/playlists       - list the signed-in user's playlists + Watch Later
// POST /api/playlists       - create a playlist { name }
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { listPlaylists } from "@/lib/services/playlist.service";

export async function GET() {
  try {
    const auth = await requireAuth();
    return api.success(await listPlaylists(auth.userId));
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Playlists Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (name.length < 2) return api.validation("A playlist name must be at least 2 characters");
    if (name.length > 60) return api.validation("A playlist name must be 60 characters or fewer");

    const count = await prisma.playlist.count({
      where: { userId: auth.userId, isWatchLater: false },
    });
    if (count >= 50) return api.error("Playlist limit (50) reached", 409, "LIMIT_REACHED");

    const playlist = await prisma.playlist.create({
      data: { userId: auth.userId, name },
      select: { id: true, name: true, isWatchLater: true, createdAt: true },
    });

    return api.success({ ...playlist, itemCount: 0, preview: [] }, "Playlist created", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Create Playlist Error]", error);
    return api.internal();
  }
}
