// =============================================================================
// GENHUB - Creator Videos Route
// GET /api/creator/videos - The creator's own videos and upload metadata.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { videoStatus } from "@/lib/video-status";
import { cacheDel } from "@/lib/redis";
import { refreshLinkedStreamtapeUpload } from "@/lib/streamtape-upload-session";

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
        creatorId: true,
        encodingStatus: true,
        encodeProgress: true,
        encodingError: true,
        encodingCheckedAt: true,
        uploadSizeBytes: true,
        createdAt: true,
      },
    });

    const withEncoding = await Promise.all(videos.map(
      async ({ streamtapeFileId, uploadSizeBytes, creatorId: videoCreatorId, ...video }) => {
        const importing = streamtapeFileId?.startsWith("pending_") ?? false;
        let liveStatus: "PROCESSING" | "READY" | "FAILED" | null = null;
        let liveProgress: number | null = null;
        if (importing && streamtapeFileId) {
          const uploadId = streamtapeFileId.slice("pending_".length);
          const result = await refreshLinkedStreamtapeUpload(uploadId, auth.userId);
          if (result) {
            liveStatus = result.state === "READY" ? "READY" : result.state === "FAILED" ? "FAILED" : "PROCESSING";
            liveProgress = result.progress;
            if (result.state === "READY" && result.fileId) {
              await prisma.video.updateMany({
                where: { id: video.id, creatorId: auth.userId, streamtapeFileId },
                data: { streamtapeFileId: result.fileId, encodingStatus: null, encodeProgress: 100 },
              });
              await cacheDel("home:feed:v3");
              await cacheDel("videos:*");
            }
            if (result.state === "FAILED") {
              await prisma.video.updateMany({
                where: { id: video.id, creatorId: auth.userId, streamtapeFileId },
                data: { encodingStatus: 5, encodeProgress: 0, encodingError: "Streamtape could not process this video. Upload it again." },
              });
            }
          }
        }
        const status = liveStatus ?? (importing ? "PROCESSING" : videoStatus(video.encodingStatus, video.encodeProgress));
        const progress = liveProgress ?? (importing ? 0 : video.encodeProgress ?? 0);
        const state = importing && status === "PROCESSING"
          ? "processing"
          : status === "FAILED"
            ? "failed"
            : status === "READY"
              ? "ready"
              : "untracked";
        return ({
        ...video,
        hasTeaser: false,
        encoding: {
          state,
          status: importing ? 2 : video.encodingStatus,
          progress,
          label: state === "processing" ? "Inachakatwa..." : state === "failed" ? "Failed" : "Ready",
          error: video.encodingError,
        },
        status,
        storedBytes: streamtapeFileId ? uploadSizeBytes : null,
        sourceBytes: uploadSizeBytes,
      });
      }
    ));

    return api.success({
      videos: withEncoding,
      processing: withEncoding.filter((video) => video.status === "PROCESSING").length,
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
