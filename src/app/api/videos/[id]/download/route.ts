// =============================================================================
// GENHUB - Video Download API Route (MEMBERS ONLY)
// GET /api/videos/[id]/download?quality=1080p
//
// Downloads are a membership right, not a public one: the viewer must either
// own the scene (PPV purchase), be an active subscriber of the creator, be an
// admin, or the scene is free. Everyone else gets 403 and a subscribe CTA.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  resolveDownloadUrl,
  pickAvailableQuality,
  getBunnyVideoDetails,
  isBunnyVideoId,
  DOWNLOAD_QUALITIES,
  type DownloadQuality,
} from "@/lib/bunny";
import config from "@/lib/config";
import { checkRateLimit } from "@/lib/redis";

function fileSafe(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "genhub-video"
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return api.unauthorized("Sign in to download this video");

    // Each call mints a fresh signed URL. Without a per-member limit, one
    // account can generate them in a loop: the signature keeps changing, so CDN
    // caching never absorbs the traffic and the bandwidth is billed to us.
    const { allowed } = await checkRateLimit(
      `download:${authUser.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many download requests — please wait a moment");
    }

    const { id } = await params;
    const requestedRaw = (request.nextUrl.searchParams.get("quality") || "1080p") as DownloadQuality;
    const requested: DownloadQuality = DOWNLOAD_QUALITIES.includes(requestedRaw)
      ? requestedRaw
      : "1080p";

    const video = await prisma.video.findFirst({
      where: { OR: [{ id }, { slug: id }], isDeleted: false, isPublished: true },
      select: {
        id: true,
        title: true,
        slug: true,
        price: true,
        creatorId: true,
        bunnyVideoId: true,
        previewUrl: true,
      },
    });

    if (!video) return api.notFound("Video not found");

    // ---------------------------------------------------------------- Access
    const isFree = video.price === 0;
    let entitled = isFree || authUser.role === "ADMIN";
    let entitlement: "free" | "purchase" | "subscription" | "admin" | null = isFree
      ? "free"
      : authUser.role === "ADMIN"
        ? "admin"
        : null;

    if (!entitled) {
      const [access, purchase, subscription] = await Promise.all([
        prisma.videoAccess.findUnique({
          where: { viewerId_videoId: { viewerId: authUser.userId, videoId: video.id } },
          select: { id: true },
        }),
        prisma.transaction.findFirst({
          where: {
            userId: authUser.userId,
            videoId: video.id,
            type: "PPV_PURCHASE",
            status: "SUCCESS",
          },
          select: { id: true },
        }),
        prisma.creatorSubscription.findFirst({
          where: {
            viewerId: authUser.userId,
            creatorId: video.creatorId,
            isActive: true,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        }),
      ]);

      if (access || purchase) {
        entitled = true;
        entitlement = "purchase";
      } else if (subscription) {
        entitled = true;
        entitlement = "subscription";
      }
    }

    if (!entitled) {
      return api.forbidden(
        "Downloads are for members — buy the video or subscribe to the creator first"
      );
    }

    // --------------------------------------------------------- Which rendition
    // Bunny only keeps MP4 fallbacks for the resolutions a video actually has,
    // so `play_1080p.mp4` on a 360p upload is a 404 — and the download menu
    // offers 1080p/720p/480p to every video, which is how "Download" became a
    // button that always failed. The row does not record which renditions Bunny
    // produced, so ask Bunny — one bounded management call, on a route that is
    // already rate-limited per member.
    let quality: DownloadQuality = requested;
    if (isBunnyVideoId(video.bunnyVideoId)) {
      try {
        const details = await getBunnyVideoDetails(video.bunnyVideoId);
        quality = pickAvailableQuality(
          (details as { availableResolutions?: string })?.availableResolutions,
          requested
        );
      } catch (error) {
        // Bunny unreachable: fall through with the requested quality rather than
        // turn a download into an error the viewer cannot act on.
        console.error("[Download Quality Lookup Error]", error);
      }
    }

    // ------------------------------------------------------------ Download URL
    // The row's Bunny id is authoritative when present: a signed MP4 rendition
    // is a member's file, whereas previewUrl is a public unsigned asset. Checked
    // after entitlement so an unentitled viewer still gets 403, never 503.
    const fileName = `${fileSafe(video.title)}-${quality}.mp4`;
    const source = resolveDownloadUrl(video, quality, 10, authUser.userId);

    if (!source.url) {
      if (source.unavailableReason === "BUNNY_NOT_CONFIGURED") {
        return api.error(
          "Bunny Stream is not configured (BUNNY_CDN_HOSTNAME / BUNNY_TOKEN_SECRET)",
          503,
          "NOT_CONFIGURED"
        );
      }
      return api.notFound("Video not found");
    }

    return api.success({
      url: source.url,
      fileName,
      quality,
      entitlement,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Video Download Error]", error);
    return api.internal();
  }
}
