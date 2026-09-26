// =============================================================================
// GENHUB - Admin Videos API Route
// GET  /api/admin/videos?creatorId=&q=  - every video a creator owns, or a search
// POST /api/admin/videos                - delete / hide / restore a single video
//
// The creators tab could see HOW MANY videos a creator had, never which ones.
// Acting on a specific scene meant opening the public profile and hoping the
// offending video was still visible — and a hidden one was invisible to the one
// person who needed to find it. This route is the missing half: the admin's view
// of the catalogue, including everything the public feed is not allowed to show.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import { deleteBunnyVideo, isBunnyVideoId } from "@/lib/bunny";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const creatorId = request.nextUrl.searchParams.get("creatorId") || "";
    const search = request.nextUrl.searchParams.get("q") || "";
    const includeDeleted = request.nextUrl.searchParams.get("deleted") === "1";

    const videos = await prisma.video.findMany({
      where: {
        ...(creatorId ? { creatorId } : {}),
        ...(includeDeleted ? {} : { isDeleted: false }),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" as const } },
                { slug: { contains: search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true,
        title: true,
        slug: true,
        price: true,
        isPublished: true,
        isFlagged: true,
        isDeleted: true,
        duration: true,
        viewsCount: true,
        purchaseCount: true,
        likesCount: true,
        dislikesCount: true,
        thumbnailUrl: true,
        createdAt: true,
        creator: {
          select: { id: true, displayName: true, email: true, phone: true, isBanned: true },
        },
      },
    });

    return api.success({ videos });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Videos List Error]", error);
    return api.internal();
  }
}

const ACTIONS = ["DELETE", "HIDE", "RESTORE", "UNFLAG"] as const;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const videoId = body?.videoId?.toString();
    const action = body?.action as (typeof ACTIONS)[number];
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : null;

    if (!videoId) return api.validation("videoId is required");
    if (!ACTIONS.includes(action)) return api.validation("Invalid action");

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        title: true,
        slug: true,
        creatorId: true,
        bunnyVideoId: true,
        isPublished: true,
        isDeleted: true,
        creator: { select: { displayName: true, email: true } },
      },
    });
    if (!video) return api.notFound("Video not found");

    const creatorLabel = video.creator.displayName || video.creator.email || video.creatorId;

    if (action === "DELETE") {
      // "Deleted" here means gone: soft-deleted in the database AND removed from
      // Bunny when it is a real Bunny asset. Soft-deleting alone left the file
      // playable by anyone who already had the signed URL, which is not what an
      // admin means by "delete this video completely".
      await prisma.video.update({
        where: { id: video.id },
        data: { isDeleted: true, isPublished: false },
      });

      if (isBunnyVideoId(video.bunnyVideoId)) {
        try {
          await deleteBunnyVideo(video.bunnyVideoId);
        } catch (error) {
          // The row is gone regardless; a Bunny outage must not leave an admin
          // unable to remove content from the site.
          console.warn("[Admin Video Delete] Bunny delete failed:", (error as Error)?.message);
        }
      }

      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.videoDelete,
        summary: `Deleted video “${video.title}” by ${creatorLabel}`,
        targetType: "video",
        targetId: video.id,
        detail: { creatorId: video.creatorId, reason },
      });

      return api.success({ isDeleted: true }, "Video deleted");
    }

    if (action === "HIDE") {
      await prisma.video.update({
        where: { id: video.id },
        data: { isPublished: false },
      });
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.videoHide,
        summary: `Hid video “${video.title}” by ${creatorLabel}`,
        targetType: "video",
        targetId: video.id,
        detail: { creatorId: video.creatorId, reason },
      });
      return api.success({ isPublished: false }, "Video hidden");
    }

    if (action === "RESTORE") {
      await prisma.video.update({
        where: { id: video.id },
        data: { isDeleted: false, isPublished: true, isFlagged: false },
      });
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.videoRestore,
        summary: `Restored video “${video.title}” by ${creatorLabel}`,
        targetType: "video",
        targetId: video.id,
        detail: { creatorId: video.creatorId },
      });
      return api.success({ isPublished: true, isDeleted: false }, "Video restored");
    }

    // UNFLAG — clear a report flag without touching publication.
    await prisma.video.update({ where: { id: video.id }, data: { isFlagged: false } });
    await recordAudit({
      actorId: auth.userId,
      action: "video.unflag",
      summary: `Cleared the flag on “${video.title}” by ${creatorLabel}`,
      targetType: "video",
      targetId: video.id,
    });
    return api.success({ isFlagged: false }, "Flag cleared");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Video Action Error]", error);
    return api.internal();
  }
}
