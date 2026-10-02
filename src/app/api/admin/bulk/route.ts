// =============================================================================
// GENHUB - Admin bulk actions
//
// POST /api/admin/bulk — apply one decision to many rows in a single request:
// approve/reject a queue of KYC submissions, ban or reinstate a set of accounts,
// delete a batch of comments, unpublish a batch of videos.
//
// A moderation backlog is worked in batches, and doing it one click at a time is
// how an operator makes a mistake on row 40. This does the same thing the
// per-item routes do, but from one screen and under ONE audit entry that names
// every target and the outcome — so a mass change reads as one timeline event an
// operator can audit, not fifty they have to reconstruct.
//
// Bounded: at most 100 targets per call, so one request cannot become an
// unbounded write, and an admin who wants to change 5,000 rows does it in
// batches they can see land.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import { invalidateAccountStatus } from "@/lib/services/account-status.service";

const ACTIONS = [
  "kyc_approve",
  "kyc_reject",
  "ban",
  "unban",
  "comment_delete",
  "video_unpublish",
] as const;

type BulkAction = (typeof ACTIONS)[number];

const MAX_TARGETS = 100;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await readJsonBody(request, {});
    const action = body?.action as BulkAction;
    const reason = body?.reason?.toString().slice(0, 500) || null;
    const ids = Array.isArray(body?.ids)
      ? (body.ids as unknown[])
          .map((v) => String(v))
          .filter(Boolean)
          .slice(0, MAX_TARGETS)
      : [];

    if (!ACTIONS.includes(action)) return api.validation("Invalid action");
    if (ids.length === 0) return api.validation("Select at least one item");

    let failed = 0;
    let summary = "";

    if (action === "kyc_approve" || action === "kyc_reject") {
      const status = action === "kyc_approve" ? "APPROVED" : "REJECTED";
      const rows = await prisma.kycVerification.findMany({
        where: { id: { in: ids } },
        select: { id: true, userId: true },
      });
      const found = new Set(rows.map((r) => r.id));
      failed = ids.length - found.size;

      await prisma.$transaction(async (tx) => {
        await tx.kycVerification.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: {
            status,
            rejectionReason: status === "REJECTED" ? reason : null,
            reviewedBy: auth.userId,
            reviewedAt: new Date(),
          },
        });
        await tx.user.updateMany({
          where: { id: { in: rows.map((r) => r.userId) } },
          data: { kycStatus: status },
        });
      });
      summary = `Bulk ${status === "APPROVED" ? "approved" : "rejected"} ${
        found.size
      } KYC submission${found.size === 1 ? "" : "s"}${
        reason ? ` — ${reason}` : ""
      }`;
      await recordAudit({
        actorId: auth.userId,
        action: status === "APPROVED" ? AUDIT_ACTIONS.kycApprove : AUDIT_ACTIONS.kycReject,
        targetType: "KycVerification",
        targetId: null,
        summary,
        detail: { ids: rows.map((r) => r.id), reason, failed },
      });
    } else if (action === "ban" || action === "unban") {
      const isBanned = action === "ban";
      const banReason = reason || "Terms violation";
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      // Never let an admin bulk-ban themselves out of the panel.
      const targets = users.map((u) => u.id).filter((id) => id !== auth.userId);
      failed = ids.length - targets.length;

      await prisma.user.updateMany({
        where: { id: { in: targets } },
        data: {
          isBanned,
          banReason: isBanned ? banReason : null,
          strikes: isBanned ? 3 : 0,
        },
      });
      if (isBanned) {
        await prisma.video.updateMany({
          where: { creatorId: { in: targets }, isPublished: true },
          data: { isPublished: false },
        });
      } else {
        for (const id of targets) invalidateAccountStatus(id);
      }
      await prisma.notification.createMany({
        data: targets.map((id) => ({
          userId: id,
          title: isBanned ? "Account suspended" : "Account reinstated",
          message: isBanned
            ? `Your account has been suspended: ${banReason}`
            : "Your account has been reinstated. Your videos can be republished.",
          type: isBanned ? "error" : "success",
          link: "/",
        })),
      });
      summary = `Bulk ${isBanned ? "suspended" : "reinstated"} ${targets.length} account${
        targets.length === 1 ? "" : "s"
      }${isBanned ? ` — ${banReason}` : ""}`;
      await recordAudit({
        actorId: auth.userId,
        action: isBanned ? AUDIT_ACTIONS.userBan : AUDIT_ACTIONS.userUnban,
        targetType: "User",
        summary,
        detail: { ids: targets, reason: isBanned ? banReason : null, failed },
      });
    } else if (action === "comment_delete") {
      const result = await prisma.comment.deleteMany({ where: { id: { in: ids } } });
      failed = ids.length - result.count;
      summary = `Bulk deleted ${result.count} comment${result.count === 1 ? "" : "s"}`;
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.commentDelete,
        targetType: "Comment",
        summary,
        detail: { ids, failed },
      });
    } else {
      const result = await prisma.video.updateMany({
        where: { id: { in: ids } },
        data: { isPublished: false },
      });
      failed = ids.length - result.count;
      summary = `Bulk unpublished ${result.count} video${result.count === 1 ? "" : "s"}`;
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.videoHide,
        targetType: "Video",
        summary,
        detail: { ids, failed },
      });
    }

    return api.success(
      { action, requested: ids.length, failed },
      summary || "Bulk action applied"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Bulk Error]", error);
    return api.internal();
  }
}
