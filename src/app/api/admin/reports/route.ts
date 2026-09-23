// =============================================================================
// GENHUB - Admin Reports & Moderation Route
// GET /api/admin/reports - List video reports
// POST /api/admin/reports - Take action on a report
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { moderateVideoSchema } from "@/lib/validation";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get("status") || "PENDING";

    const reports = await prisma.videoReport.findMany({
      where: { status: status as any },
      orderBy: { createdAt: "desc" },
      include: {
        reporter: {
          select: { id: true, displayName: true, phone: true },
        },
        video: {
          select: {
            id: true,
            title: true,
            thumbnailUrl: true,
            creatorId: true,
            creator: { select: { id: true, displayName: true, strikes: true } },
          },
        },
      },
    });

    return api.success(reports);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Reports Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const result = moderateVideoSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { reportId, action, reason } = result.data;

    const report = await prisma.videoReport.findUnique({
      where: { id: reportId },
      include: { video: true },
    });

    if (!report) return api.notFound("Report not found");

    await prisma.$transaction(async (tx) => {
      // Update report status
      await tx.videoReport.update({
        where: { id: reportId },
        data: {
          status: action === "DISMISSED" ? "DISMISSED" : "RESOLVED",
          resolvedBy: auth.userId,
          resolvedAt: new Date(),
        },
      });

      // Take action on video
      if (action === "HIDDEN") {
        await tx.video.update({
          where: { id: report.videoId },
          data: { isPublished: false, isFlagged: true },
        });
      }

      if (action === "FROZEN_EARNINGS") {
        await tx.video.update({
          where: { id: report.videoId },
          data: { isFlagged: true },
        });
        // Freeze earnings by setting price to 0 temporarily
      }

      // Strike the creator
      if (["HIDDEN", "FROZEN_EARNINGS", "WARNING", "BANNED"].includes(action)) {
        const updatedUser = await tx.user.update({
          where: { id: report.video.creatorId },
          data: { strikes: { increment: 1 } },
          select: { strikes: true },
        });

        // Log the strike
        await tx.strikeLog.create({
          data: {
            creatorId: report.video.creatorId,
            action: action as any,
            reason,
            videoId: report.videoId,
            issuedBy: auth.userId,
          },
        });

        // Auto-ban at 3 strikes
        if (updatedUser.strikes >= 3) {
          await tx.user.update({
            where: { id: report.video.creatorId },
            data: {
              isBanned: true,
              banReason: "Automatic ban: 3 strikes reached",
            },
          });
        }
      }
    });

    return api.success(null, "Kitendo kimefanyika");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Report Action Error]", error);
    return api.internal();
  }
}
