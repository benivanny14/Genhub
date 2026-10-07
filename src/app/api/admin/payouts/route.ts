// =============================================================================
// GENHUB - Admin Payout Management Route
// GET /api/admin/payouts - List payout requests
// POST /api/admin/payouts - Approve, reject, or mark as paid
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import { createNotification } from "@/lib/services/notify.service";
import {
  disbursePayout,
  gatewayMinPayout,
} from "@/lib/services/payout-disbursement.service";
import { payoutAttention, summarizePayoutAttention } from "@/lib/payout-attention";
import { z } from "zod";
import { intParam } from "@/lib/utils";

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
    const page = intParam(searchParams.get("page"), 1);
    const limit = intParam(searchParams.get("limit"), 20, 50);

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

    const gatewayMinimum = gatewayMinPayout();
    const now = Date.now();

    /*
     * How long each request has waited, and what it needs next — derived here so
     * the screen does not have to re-implement the rule (see
     * lib/payout-attention.ts for why the three states look alike and mean
     * different things).
     *
     * Sent with every row rather than as a separate endpoint: an admin looking
     * for "what is stuck" is looking at exactly this list, and a second read
     * would be a second answer that can disagree with it.
     */
    const rows = payouts.map((payout) => ({
      ...payout,
      attention: payoutAttention(payout, { now, gatewayMinimum }),
    }));

    return api.success({
      payouts: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      // The floor the GATEWAY will send, so the queue can say "this one is a hand
      // payment" next to the amount instead of repeating the number in the
      // client, where it would go stale the day SonicPesa changes theirs. Not
      // `config.business.minPayoutAmount`: that one an admin can waive, this one
      // nobody can.
      gatewayMinimum,
      // One line about the page being read: how much is open, how much of it has
      // stopped moving, and which row has waited longest. `total` above is the
      // whole queue in the database; this is what is on screen. They differ only
      // when the queue is paginated past one page, which is why both are here.
      summary: summarizePayoutAttention(rows),
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
    if (value.action !== "PAID") return;

    if (!value.paymentReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentReference"],
        message: "A receipt or reference number is required to mark a payout paid",
      });
      return;
    }

    // ...and it has to look like a transaction code. An M-Pesa, Tigo, Airtel or
    // bank reference always carries digits; a name or a memo never does. When
    // the platform cannot send money itself, a hand-typed "paid" is the only
    // record of the money leaving, and a receipt of "moi sasha" (a creator's
    // own name) is not a record of anything — it is a request being cleared
    // without the money having moved. This is the one place that can refuse it.
    if (!/\d/.test(value.paymentReference)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentReference"],
        message:
          "That does not look like a receipt — a transaction code contains digits. Send the money first, then paste the code you were given.",
      });
    }
  });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await readJsonBody(request);
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

    // Reasons the gateway cannot take this payout, which are not failures of the
    // request: the admin sends it by hand exactly as before and says so with the
    // receipt. Everything else is a real refusal and the request stays open.
    //
    // BELOW_GATEWAY_MINIMUM belongs on this list, and the reason it exists is
    // worth stating: an admin can waive Genhub's own TZS 30,000 withdrawal floor
    // for one creator, which lets them request a smaller amount — but the
    // gateway will not SEND less than TZS 30,000, whatever we have agreed to
    // internally. Returning an error for that made a hand-payable withdrawal look
    // impossible; approving it records the decision and tells the admin to pay it
    // from the phone and mark it paid with the receipt.
    const GATEWAY_CANNOT_TAKE_IT = [
      "NOT_ENABLED",
      "NOT_CONFIGURED",
      "UNSUPPORTED_METHOD",
      "BELOW_GATEWAY_MINIMUM",
    ];
    /** Set when the payout was sent automatically, for the response sentence. */
    let sent: { netAmount: number; withdrawalId: number } | null = null;
    /** Set when automated payouts could not be used, so a human must send it. */
    let manualReason: string | null = null;

    if (action === "REJECTED") {
      // Rejected: return funds to available balance.
      await prisma.$transaction(async (tx) => {
        await tx.payoutRequest.update({ where: { id: payoutId }, data: decision });

        await tx.creatorBalance.update({
          where: { creatorId: payout.creatorId },
          data: { availableBalance: { increment: payout.amount } },
        });
      });
    } else if (action === "APPROVED") {
      /*
       * Approving is the moment money leaves, so it is the moment to try and send
       * it. disbursePayout owns the whole transition: the gateway call, the claim
       * that stops a double send, and the receipt the gateway returns. It leaves
       * the row APPROVED — never PAID — because only the gateway's own verdict
       * makes a payout paid.
       */
      const outcome = await disbursePayout({ payoutId, actorId: auth.userId });

      if (outcome.ok) {
        sent = { netAmount: outcome.netAmount, withdrawalId: outcome.withdrawalId };
      } else if (GATEWAY_CANNOT_TAKE_IT.includes(outcome.reason)) {
        // Fall back to the manual path: record the approval and say plainly that
        // a person still has to send it.
        await prisma.payoutRequest.update({ where: { id: payoutId }, data: decision });
        manualReason = outcome.message;
      } else {
        /*
         * The gateway was asked and refused (or the call is mid-flight). Nothing
         * moved and the balance is untouched, so the request stays where it was.
         *
         * api.upstream, not api.error: who was asked and what it said belong in
         * the log beside a reference, and the admin gets the sentence they can
         * act on. The gateway's own words are part of that sentence on purpose —
         * "invalid phone number" is what tells them which field to fix.
         */
        return api.upstream(
          `payout ${payoutId} was not sent (${outcome.reason}): ${outcome.message}`,
          {
            context: "Admin Payouts",
            status: 502,
            code: "PAYOUT_NOT_SENT",
            message: `Nothing was sent and the balance is unchanged. The payout was refused: ${outcome.message}`,
          }
        );
      }
    } else {
      await prisma.payoutRequest.update({ where: { id: payoutId }, data: decision });
    }

    // Notify the creator about the decision
    try {
      const messages: Record<string, { title: string; message: string; type: string }> = {
        APPROVED: sent
          ? {
              title: "Payout on its way 💸",
              // The net amount, because that is what will show on the handset. The
              // gateway takes its fee out of the amount sent, and a creator who
              // was told 30,000 and received less would rightly call that a lie.
              message: `TZS ${payout.amount.toLocaleString()} has been sent to ${payout.accountDetails}. You will receive about TZS ${sent.netAmount.toLocaleString()} after the mobile-money fee (gateway ref ${sent.withdrawalId}).`,
              type: "success",
            }
          : {
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
      await createNotification({
        userId: payout.creatorId,
        title: n.title,
        message: n.message,
        type: n.type,
        link: "/creator",
        pushTag: "payout",
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

    // When the gateway took the payout, disbursePayout has already written the
    // better audit line — with the withdrawal id and the fee. Writing this
    // generic one too would put two entries on one action and leave an operator
    // guessing which describes what happened.
    if (!(action === "APPROVED" && sent)) {
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
    }

    /*
     * The response sentence is the admin's only confirmation, so it says which
     * of the three things actually happened: the gateway sent it, the gateway
     * could not take it so a person must, or a decision was recorded.
     */
    const confirmation =
      action === "PAID"
        ? "Withdrawal request paid"
        : action === "REJECTED"
          ? "Withdrawal request rejected"
          : sent
            ? `Sent through the gateway — withdrawal ${sent.withdrawalId}, the creator receives about TZS ${sent.netAmount.toLocaleString()} after the fee`
            : manualReason
              ? `Approved — not sent automatically. ${manualReason} Send it yourself, then mark it paid with the receipt.`
              : "Withdrawal request approved";

    return api.success(null, confirmation);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payout Review Error]", error);
    return api.internal();
  }
}
