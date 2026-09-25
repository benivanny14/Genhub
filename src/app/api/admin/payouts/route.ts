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
    // A comma-separated list, so the queue can hold every request that is still
    // open — PENDING and APPROVED — in one read. `status=PENDING` alone is how
    // an approved request vanished from the only screen that could finish it.
    //
    // Unknown values are dropped rather than passed through: this used to be a
    // bare `as any`, so a typo in the query string reached Prisma as an invalid
    // enum and came back as a 500 instead of a list.
    const ALL_STATUSES = ["PENDING", "APPROVED", "PAID", "REJECTED"] as const;
    const requested = (searchParams.get("status") || "PENDING")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is (typeof ALL_STATUSES)[number] =>
        (ALL_STATUSES as readonly string[]).includes(s)
      );
    const statuses = requested.length ? requested : ["PENDING" as const];
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));

    const [payouts, total] = await Promise.all([
      prisma.payoutRequest.findMany({
        where: { status: { in: statuses } },
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
      prisma.payoutRequest.count({ where: { status: { in: statuses } } }),
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

const reviewPayoutSchema = z
  .object({
    payoutId: z.string().min(1),
    action: z.enum(["APPROVED", "PAID", "REJECTED"]),
    adminNote: z.string().optional(),
    /**
     * The M-Pesa / bank receipt (transaction code) the admin got when they sent
     * the money. Refused as empty because "" is not a receipt, and required on
     * PAID — see the check below.
     */
    paymentReference: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((value, ctx) => {
    // Marking a payout paid used to be an assertion: the creator was told
    // "paid" with nothing to check it against. The receipt is the whole proof,
    // so it is not optional on the one action that claims money left.
    if (value.action === "PAID" && !value.paymentReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentReference"],
        message: "A receipt or reference number is required to mark a payout paid",
      });
    }
  });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const result = reviewPayoutSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { payoutId, action, adminNote, paymentReference } = result.data;

    const payout = await prisma.payoutRequest.findUnique({
      where: { id: payoutId },
      // The creator's name is for the audit line: "paid TZS 120,000 to Ivanny" is
      // the sentence the person reading the log needs, not a cuid.
      include: { creator: { select: { displayName: true, email: true } } },
    });

    if (!payout) return api.notFound("Withdrawal request not found");

    // Which decisions are still available on this request.
    //
    // Approving says "we will send this"; marking it paid says "we sent it" — so
    // PAID has to be reachable from APPROVED. Requiring PENDING for every action
    // made the Approve button a dead end: the request left the queue, could never
    // be completed, and the creator's money stayed earmarked — neither available
    // to them nor paid out.
    //
    // A decision on a request that is already PAID or REJECTED is still refused,
    // which is what would double-refund a rejection.
    const allowedFrom: Record<string, string[]> = {
      APPROVED: ["PENDING"],
      PAID: ["PENDING", "APPROVED"],
      REJECTED: ["PENDING", "APPROVED"],
    };

    if (!allowedFrom[action].includes(payout.status)) {
      return api.error(
        `This request has already been processed: ${payout.status}`,
        409,
        "ALREADY_PROCESSED"
      );
    }

    // One decision payload for both branches. The receipt is written only for
    // PAID: approving and rejecting never sent anything, so they have nothing to
    // reference and must not overwrite a value they do not own.
    const decision = {
      status: action,
      adminNote,
      processedBy: auth.userId,
      processedAt: new Date(),
      paymentReference: action === "PAID" ? paymentReference : undefined,
    };

    // If rejected, return funds to available balance
    if (action === "REJECTED") {
      await prisma.$transaction(async (tx) => {
        await tx.payoutRequest.update({ where: { id: payoutId }, data: decision });

        await tx.creatorBalance.update({
          where: { creatorId: payout.creatorId },
          data: { availableBalance: { increment: payout.amount } },
        });
      });
    } else {
      await prisma.payoutRequest.update({ where: { id: payoutId }, data: decision });
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
          // The receipt is in the notification, not only on the dashboard: this
          // is the message the creator reads next to the M-Pesa SMS, and it is
          // what they quote if the money never arrived.
          message: `TZS ${payout.amount.toLocaleString()} has been paid out. Receipt / reference: ${
            paymentReference || "—"
          }. Thank you for creating on Genhub!`,
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
    // The receipt belongs in the sentence, not only in `detail`: "who moved this
    // money, and against which transaction" is exactly what the log is read for
    // during a dispute.
    const summaryParts = [
      `${verb} TZS ${payout.amount.toLocaleString()} for ${
        payout.creator?.displayName || payout.creator?.email || payout.creatorId
      }`,
    ];
    if (action === "PAID" && paymentReference) summaryParts.push(`receipt ${paymentReference}`);
    if (adminNote) summaryParts.push(adminNote);

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
      summary: summaryParts.join(" — "),
      detail: {
        amount: payout.amount,
        creatorId: payout.creatorId,
        paymentMethod: payout.paymentMethod,
        adminNote: adminNote ?? null,
        paymentReference: action === "PAID" ? paymentReference ?? null : null,
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
