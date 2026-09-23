// =============================================================================
// GENHUB - Watch Progress API Route
// POST /api/videos/[id]/progress - Save playback position (resume/continue)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

// GET /api/videos/[id]/progress - Saved position (for resume playback)
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return api.success({ positionSeconds: 0, percent: 0 });
    }

    const progress = await prisma.watchProgress.findUnique({
      where: { userId_videoId: { userId: user.userId, videoId: params.id } },
      select: { positionSeconds: true, percent: true },
    });

    return api.success(progress || { positionSeconds: 0, percent: 0 });
  } catch (error) {
    console.error("[Get Watch Progress Error]", error);
    return api.internal();
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const id = params.id;

    const body = await request.json().catch(() => ({}));
    const positionSeconds = Math.max(0, Math.floor(Number(body?.positionSeconds) || 0));
    const duration = Math.floor(Number(body?.duration) || 0);
    const percent =
      duration > 0 ? Math.min(100, Math.max(0, Math.round((positionSeconds / duration) * 100))) : 0;

    const video = await prisma.video.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!video) return api.notFound("Video not found");

    await prisma.watchProgress.upsert({
      where: { userId_videoId: { userId: auth.userId, videoId: id } },
      create: {
        userId: auth.userId,
        videoId: id,
        positionSeconds,
        percent,
      },
      update: {
        positionSeconds,
        percent,
        updatedAt: new Date(),
      },
    });

    return api.success({ positionSeconds, percent });
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Watch Progress Error]", error);
    return api.internal();
  }
}
