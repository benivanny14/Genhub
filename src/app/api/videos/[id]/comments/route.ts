// =============================================================================
// GENHUB - Video Comments API Route
// GET /api/videos/[id]/comments - List threaded comments
// POST /api/videos/[id]/comments - Create comment or reply
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

const userSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  role: true,
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const id = params.id;

    const comments = await prisma.comment.findMany({
      where: { videoId: id, parentId: null, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        user: { select: userSelect },
        replies: {
          where: { isDeleted: false },
          orderBy: { createdAt: "asc" },
          include: { user: { select: userSelect } },
        },
      },
    });

    const total = await prisma.comment.count({
      where: { videoId: id, isDeleted: false },
    });

    return api.success({ comments, total });
  } catch (error) {
    console.error("[List Comments Error]", error);
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

    const { allowed } = await checkRateLimit(
      `comment:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many comments — please wait a moment");

    const body = await request.json();
    const text = (body?.body ?? "").toString().trim();
    const parentId = body?.parentId ? body.parentId.toString() : null;

    if (!text) return api.validation("Comment cannot be empty");
    if (text.length > 1000) {
      return api.validation("Comment must be 1000 characters or fewer");
    }

    // Video must exist and be visible
    const video = await prisma.video.findFirst({
      where: { id, isDeleted: false },
      select: { id: true, creatorId: true, title: true },
    });
    if (!video) return api.notFound("Video not found");

    // Reply must belong to the same video
    if (parentId) {
      const parent = await prisma.comment.findFirst({
        where: { id: parentId, videoId: id, isDeleted: false },
        select: { id: true },
      });
      if (!parent) return api.notFound("Parent comment not found");
    }

    const comment = await prisma.comment.create({
      data: {
        videoId: id,
        userId: auth.userId,
        parentId,
        body: text,
      },
      include: {
        user: { select: userSelect },
      },
    });

    // Notify the creator (but not on their own video)
    if (video.creatorId !== auth.userId) {
      const commenter = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { displayName: true },
      });
      await prisma.notification.create({
        data: {
          userId: video.creatorId,
          title: parentId ? "New reply" : "New comment",
          message: `${commenter?.displayName || "Someone"} commented on "${video.title}"`,
          type: "info",
          link: `/video/${video.id}`,
        },
      });
    }

    return api.success(comment, "Comment posted", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Create Comment Error]", error);
    return api.internal();
  }
}
