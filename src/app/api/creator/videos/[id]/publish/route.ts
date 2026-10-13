// =============================================================================
// GENHUB - Publish / Unpublish a Video
// POST /api/creator/videos/[id]/publish  { published: boolean }
//
// A video is published only after Streamtape conversion has completed. This
// endpoint lets its creator or admin toggle publication afterward; it does not
// trigger encoding or provider-side status checks.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRole("CREATOR");
    // Next 15 hands route params over as a promise.
    const { id } = await params;

    const body = await readJsonBody(request, {});
    if (typeof body?.published !== "boolean") {
      return api.validation("published must be true or false");
    }

    // Scoped by creatorId, so this cannot be used to touch someone else's video
    // even with a valid id.
    const video = await prisma.video.findFirst({
      where: { id, creatorId: auth.userId, isDeleted: false },
      select: {
        id: true,
        title: true,
        slug: true,
        streamtapeFileId: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    if (body.published && !video.streamtapeFileId) {
      return api.error(
        "This legacy video must be reuploaded before it can be published.",
        409,
        "VIDEO_REUPLOAD_REQUIRED"
      );
    }

    const encoding = {
      state: "ready" as const,
      status: null,
      progress: 100,
      label: "Ready",
      error: null,
    };
    const warning = null;

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
