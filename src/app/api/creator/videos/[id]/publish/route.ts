// =============================================================================
// GENHUB - Publish / Unpublish a Video
// POST /api/creator/videos/[id]/publish  { published: boolean }
//
// Videos Bunny has to transcode are held unpublished until it can serve them
// (see lib/services/video-encoding.service.ts). This is the creator's override.
//
// The override exists for a specific failure: if Bunny never reports the video
// as finished — a stuck encode, an account problem, a code Bunny changes without
// telling anyone — then an automatic gate with no exit would leave the creator
// permanently unable to publish, with no error and nothing to click. A gate that
// cannot be opened by hand is worse than no gate.
//
// Unpublishing is allowed at any time and is never reversed by the poller: it
// only ever flips a video from unpublished to published, never back.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { describeEncoding } from "@/lib/services/video-encoding.service";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireRole("CREATOR");

    const body = await request.json().catch(() => ({}));
    if (typeof body?.published !== "boolean") {
      return api.validation("published must be true or false");
    }

    // Scoped by creatorId, so this cannot be used to touch someone else's video
    // even with a valid id.
    const video = await prisma.video.findFirst({
      where: { id: params.id, creatorId: auth.userId, isDeleted: false },
      select: {
        id: true,
        title: true,
        slug: true,
        encodingStatus: true,
        encodeProgress: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    const encoding = describeEncoding(video.encodingStatus, video.encodeProgress);

    // Publishing something Bunny cannot serve yet is allowed, but the caller is
    // told plainly rather than being let into a silent broken player.
    const warning =
      body.published && encoding.state !== "ready"
        ? `This video is still ${encoding.label.toLowerCase()}. Viewers may not be able to play it yet.`
        : null;

    const updated = await prisma.video.update({
      where: { id: video.id },
      data: { isPublished: body.published },
      select: { id: true, title: true, slug: true, isPublished: true },
    });

    return api.success(
      { ...updated, encoding, warning },
      body.published ? "Video published" : "Video unpublished"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Publish Video Error]", error);
    return api.internal();
  }
}
