// =============================================================================
// GENHUB - Report Comment API Route
// POST /api/comments/[id]/report { reason? } - flag a comment for moderation.
// The report is recorded against the comment's video so moderators see the
// context (admin /api/admin/reports). Called by CommentsSection.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();

    // Moderation queues are human-reviewed: an unlimited report button lets one
    // account bury genuine reports under noise.
    const { allowed } = await checkRateLimit(
      `report:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many reports — please wait a moment");

    const body = await request.json().catch(() => ({}));
    const reason = ["DMCA", "INAPPROPRIATE", "SPAM"].includes(body?.reason)
      ? body.reason
      : "SPAM";

    const comment = await prisma.comment.findUnique({
      where: { id: params.id },
      select: { id: true, videoId: true, body: true, isDeleted: true },
    });

    if (!comment || comment.isDeleted) return api.notFound("Comment not found");

    // One open report per reporter per comment (mirrors the video guard)
    const existing = await prisma.videoReport.findFirst({
      where: {
        reporterId: auth.userId,
        videoId: comment.videoId,
        status: "PENDING",
        description: { startsWith: `[comment ${comment.id}]` },
      },
      select: { id: true },
    });
    if (existing) {
      return api.error(
        "You have already reported this comment",
        409,
        "ALREADY_REPORTED"
      );
    }

    // Record the report against the comment's video so moderators see it
    await prisma.videoReport.create({
      data: {
        reporterId: auth.userId,
        videoId: comment.videoId,
        reason,
        description: `[comment ${comment.id}] ${comment.body.slice(0, 250)}`,
      },
    });

    return api.success(null, "Report submitted. Our moderators will review it.");
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Report Comment Error]", error);
    return api.internal();
  }
}
