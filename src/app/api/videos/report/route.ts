// =============================================================================
// GENHUB - Report Video API Route
// POST /api/videos/report { videoId, reason, description? } - flag content for
// moderation. Reports land in /api/admin/reports (PENDING) and count toward
// the admin overview badge.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { reportVideoSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const { allowed } = await checkRateLimit(
      `report:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many reports — please wait a moment");

    const body = await request.json().catch(() => ({}));
    const result = reportVideoSchema.safeParse(body);
    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }
    const { videoId, reason, description } = result.data;

    const video = await prisma.video.findFirst({
      where: { id: videoId, isDeleted: false },
      select: { id: true },
    });
    if (!video) return api.notFound("Video not found");

    // One open report per reporter per video
    const existing = await prisma.videoReport.findFirst({
      where: { reporterId: auth.userId, videoId, status: "PENDING" },
      select: { id: true },
    });
    if (existing) {
      return api.error(
        "You have already reported this video and it is being reviewed",
        409,
        "ALREADY_REPORTED"
      );
    }

    const report = await prisma.videoReport.create({
      data: {
        reporterId: auth.userId,
        videoId,
        reason,
        description: description || null,
      },
    });

    return api.success(
      report,
      "Report submitted. Thank you for helping keep the platform safe.",
      201
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Video Report Error]", error);
    return api.internal();
  }
}
