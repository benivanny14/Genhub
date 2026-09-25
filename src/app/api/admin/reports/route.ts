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
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

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
      include: {
        video: { include: { creator: { select: { displayName: true, email: true } } } },
      },
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

    // A moderation decision is a strike against a creator's account and can ban
    // them outright. Both the action and the reason belong in the log, next to
    // whoever issued it — StrikeLog records that a strike happened, never who
    // decided it or why the report was upheld.
    await recordAudit({
      actorId: auth.userId,
      action: action === "DISMISSED" ? AUDIT_ACTIONS.reportDismiss : AUDIT_ACTIONS.reportResolve,
      targetType: "VideoReport",
      targetId: reportId,
      summary: `${action === "DISMISSED" ? "Dismissed" : action} — "${
        report.video?.title || report.videoId
      }" by ${
        report.video?.creator?.displayName || report.video?.creator?.email || report.video?.creatorId
      } — reason: ${reason}`,
      detail: {
        action,
        reason,
        videoId: report.videoId,
        creatorId: report.video?.creatorId ?? null,
      },
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
