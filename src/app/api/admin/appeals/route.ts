// =============================================================================
// GENHUB - Admin appeals queue
//
// GET  /api/admin/appeals — pending (or resolved) appeals with the account.
// POST /api/admin/appeals — decide one. Approving a BAN appeal reinstates the
//      account, because the appeal and the reinstatement are the same decision;
//      leaving the admin to also click "unban" is how a person is told they are
//      back but stays locked out.
//
// Every decision writes its author and an audit row, so the appeal row can be
// tidied later without erasing that a decision happened and who made it.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import { invalidateAccountStatus } from "@/lib/services/account-status.service";
import { pushForNotification } from "@/lib/services/notify.service";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const status = request.nextUrl.searchParams.get("status") || "PENDING";
    const valid = ["PENDING", "APPROVED", "REJECTED"] as const;
    const where = valid.includes(status as (typeof valid)[number])
      ? { status: status as (typeof valid)[number] }
      : {};

    const appeals = await prisma.appeal.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
            email: true,
            isBanned: true,
            banReason: true,
            role: true,
          },
        },
      },
    });

    const counts = await prisma.appeal.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    return api.success({
      appeals,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Appeals List Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await readJsonBody(request, {});
    const appealId = body?.appealId?.toString();
    const decision = body?.decision as "APPROVED" | "REJECTED";
    const note = body?.note?.toString().slice(0, 500) || null;

    if (!appealId) return api.validation("appealId is required");
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      return api.validation("Invalid decision");
    }

    const appeal = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    if (!appeal) return api.notFound("Appeal not found");
    if (appeal.status !== "PENDING") {
      return api.error("This appeal has already been decided", 409, "ALREADY_DECIDED");
    }

    await prisma.$transaction(async (tx) => {
      await tx.appeal.update({
        where: { id: appealId },
        data: {
          status: decision,
          reviewerNote: note,
          reviewedBy: auth.userId,
          reviewedAt: new Date(),
        },
      });

      // Approving a ban appeal IS the reinstatement.
      if (decision === "APPROVED" && appeal.kind === "BAN") {
        await tx.user.update({
          where: { id: appeal.userId },
          data: { isBanned: false, banReason: null, strikes: 0 },
        });
      }

      await tx.notification.create({
        data: {
          userId: appeal.userId,
          title:
            decision === "APPROVED"
              ? "Your appeal was approved 🎉"
              : "Your appeal was reviewed",
          message:
            decision === "APPROVED"
              ? "An admin has approved your appeal. Welcome back — your account is active again."
              : `We reviewed your appeal and did not change our decision.${
                  note ? ` ${note}` : ""
                }`,
          type: decision === "APPROVED" ? "success" : "info",
          link: "/",
        },
      });
    });

    // The in-app notice was written inside the transaction; the lock-screen
    // mirror fires here, after the outcome committed. A rejection that a device
    // learns about before it is durable would be a message about a decision
    // that never happened.
    void pushForNotification({
      userId: appeal.userId,
      title:
        decision === "APPROVED"
          ? "Your appeal was approved 🎉"
          : "Your appeal was reviewed",
      message:
        decision === "APPROVED"
          ? "An admin has approved your appeal. Welcome back — your account is active again."
          : `We reviewed your appeal and did not change our decision.${note ? ` ${note}` : ""}`,
      link: "/",
    });

    if (decision === "APPROVED" && appeal.kind === "BAN") {
      // Drop the cached ban verdict so the reinstated account works at once.
      invalidateAccountStatus(appeal.userId);
    }

    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.appealResolved,
      targetType: "Appeal",
      targetId: appealId,
      summary: `${decision === "APPROVED" ? "Approved" : "Rejected"} the appeal from ${
        appeal.user.displayName || appeal.user.email || appeal.userId
      }${note ? ` — ${note}` : ""}`,
      detail: {
        userId: appeal.userId,
        kind: appeal.kind,
        decision,
        bannedRestored: decision === "APPROVED" && appeal.kind === "BAN",
      },
    });

    return api.success(
      { status: decision },
      decision === "APPROVED" ? "Appeal approved" : "Appeal rejected"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Appeal Decision Error]", error);
    return api.internal();
  }
}
