// =============================================================================
// GENHUB - Admin Payout Management Route
// GET /api/admin/payouts - List payout requests
// POST /api/admin/payouts - Approve, reject, or mark as paid
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import { z } from "zod";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get("status") || "PENDING";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));

    const [payouts, total] = await Promise.all([
      prisma.payoutRequest.findMany({
        where: { status: status as any },
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          creator: {
            select: {
              id: true,
              displayName: true,
              phone: true,
              email: true,
              kycStatus: true,
            },
          },
        },
      }),
      prisma.payoutRequest.count({ where: { status: status as any } }),
    ]);

    return api.success({
      payouts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payouts Error]", error);
    return api.internal();
  }
}

const reviewPayoutSchema = z.object({
  payoutId: z.string().min(1),
  action: z.enum(["APPROVED", "PAID", "REJECTED"]),
  adminNote: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const result = reviewPayoutSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { payoutId, action, adminNote } = result.data;

    const payout = await prisma.payoutRequest.findUnique({
      where: { id: payoutId },
      // The creator's name is for the audit line: "paid TZS 120,000 to Ivanny" is
      // the sentence the person reading the log needs, not a cuid.
      include: { creator: { select: { displayName: true, email: true } } },
    });

    if (!payout) return api.notFound("Withdrawal request not found");

    // Only PENDING requests may be reviewed — prevents double refunds when
    // the same request is rejected twice.
    if (payout.status !== "PENDING") {
      return api.error(
        `This request has already been processed: ${payout.status}`,
        409,
        "ALREADY_PROCESSED"
      );
    }

    // If rejected, return funds to available balance
    if (action === "REJECTED") {
      await prisma.$transaction(async (tx) => {
        await tx.payoutRequest.update({
          where: { id: payoutId },
          data: {
            status: "REJECTED",
            adminNote,
            processedBy: auth.userId,
            processedAt: new Date(),
          },
        });

        await tx.creatorBalance.update({
          where: { creatorId: payout.creatorId },
          data: { availableBalance: { increment: payout.amount } },
        });
      });
    } else {
      await prisma.payoutRequest.update({
        where: { id: payoutId },
        data: {
          status: action,
          adminNote,
          processedBy: auth.userId,
          processedAt: new Date(),
        },
      });
    }

    // Notify the creator about the decision
    try {
      const messages: Record<string, { title: string; message: string; type: string }> = {
        APPROVED: {
          title: "Payout approved ✅",
          message: `Your payout request of TZS ${payout.amount.toLocaleString()} has been approved and is being processed.`,
          type: "success",
        },
        PAID: {
          title: "Payout completed 💸",
          message: `TZS ${payout.amount.toLocaleString()} has been paid out. Thank you for creating on Genhub!`,
          type: "success",
        },
        REJECTED: {
          title: "Payout rejected",
          message: `Your payout request of TZS ${payout.amount.toLocaleString()} was rejected.${adminNote ? ` Reason: ${adminNote}` : ""} The funds were returned to your available balance.`,
          type: "error",
        },
      };
      const n = messages[action];
      await prisma.notification.create({
        data: {
          userId: payout.creatorId,
          title: n.title,
          message: n.message,
          type: n.type,
          link: "/creator",
        },
      });
    } catch (notifyError) {
      console.warn("[Admin Payout] Notification failed:", (notifyError as Error)?.message);
    }

    const verb =
      action === "APPROVED" ? "Approved" : action === "PAID" ? "Paid out" : "Rejected";
    await recordAudit({
      actorId: auth.userId,
      action:
        action === "APPROVED"
          ? AUDIT_ACTIONS.payoutApprove
          : action === "PAID"
            ? AUDIT_ACTIONS.payoutPaid
            : AUDIT_ACTIONS.payoutReject,
      targetType: "PayoutRequest",
      targetId: payoutId,
      summary: `${verb} TZS ${payout.amount.toLocaleString()} for ${
        payout.creator?.displayName || payout.creator?.email || payout.creatorId
      }${adminNote ? ` — ${adminNote}` : ""}`,
      detail: {
        amount: payout.amount,
        creatorId: payout.creatorId,
        paymentMethod: payout.paymentMethod,
        adminNote: adminNote ?? null,
        // Rejecting returns the money to the creator's available balance; the
        // log has to say so, because the balance itself will not explain it.
        fundsReturned: action === "REJECTED",
      },
    });

    return api.success(null, `Withdrawal request ${action === "APPROVED" ? "approved" : action === "PAID" ? "paid" : "rejected"}`);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payout Review Error]", error);
    return api.internal();
  }
}
