// =============================================================================
// GENHUB - Creator Videos Route
// GET /api/creator/videos - The creator's own videos and upload metadata.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { videoStatus } from "@/lib/video-status";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const videos = await prisma.video.findMany({
      where: { creatorId: auth.userId, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        description: true,
        slug: true,
        price: true,
        isPublished: true,
        // Draft / schedule state, so the creator's own list can say "draft" or
        // "goes live at 20:00" instead of a flat "Not live".
        isDraft: true,
        scheduledAt: true,
        viewsCount: true,
        purchaseCount: true,
        // Without this the creator's own list had no image to show, which is how
        // a broken thumbnail stayed invisible to the one person who could fix it.
        thumbnailUrl: true,
        duration: true,
        teaserDuration: true,
        // The edit form owns title, price, description, cover, category, tags,
        // preview length and captions; a field the API does not return is a
        // field the creator cannot edit without retyping it from memory.
        category: true,
        tags: true,
        captionsUrl: true,
        streamtapeFileId: true,
        encodingStatus: true,
        encodeProgress: true,
        encodingError: true,
        encodingCheckedAt: true,
        uploadSizeBytes: true,
        createdAt: true,
      },
    });

    const withEncoding = videos.map(
      ({ streamtapeFileId, uploadSizeBytes, ...video }) => ({
        ...video,
        hasTeaser: false,
        encoding: {
          state: "ready" as const,
          status: null,
          progress: 100,
          label: "Ready",
          error: null,
        },
        status: videoStatus(video.encodingStatus, video.encodeProgress),
        storedBytes: streamtapeFileId ? uploadSizeBytes : null,
        sourceBytes: uploadSizeBytes,
      })
    );

    return api.success({
      videos: withEncoding,
      processing: 0,
      awaitingPublish: 0,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Creator Videos Error]", error);
    return api.internal();
  }
}
