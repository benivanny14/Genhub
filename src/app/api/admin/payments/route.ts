// =============================================================================
// GENHUB - Admin Payment Operations
// GET  /api/admin/payments?status=PENDING&page=1  - inspect charges
// POST /api/admin/payments { action, transactionId, ... } - act on ONE charge.
//
// Actions:
//   expire       force-release a stuck PENDING charge so the customer can retry
//                (a late settlement is still honoured, so nothing is lost)
//   recheck      ask the gateway right now — settles it if the gateway has a
//                verdict, changes nothing if it still says "processing"
//   grant        the customer DID pay: settle through the normal webhook path
//                so access unlocks and the 70/30 split is recorded
//   mark_unpaid  the money never moved: release it and tell the customer they
//                can safely retry
//   refund       the customer DID pay but cannot get what they bought: return
//                the money and take back the creator's 70%
//
// `grant` and `mark_unpaid` are the two ways out of UNDER_INVESTIGATION, and
// they are the reason this panel exists: a charge whose USSD prompt was
// accepted but never settled must never be auto-labelled "failed", because
// telling a customer to pay again when their money already left the handset is
// how one purchase gets charged twice.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  expirePaymentCharge,
  recheckPaymentCharge,
  resolveInvestigation,
} from "@/lib/services/payment-reconcile.service";
import { reverseCollectedCharge } from "@/lib/services/payment-reversal.service";
import { z } from "zod";

// A USSD prompt answered normally settles in a couple of minutes; past this the
// charge is only worth investigating.
const STUCK_MINUTES = 15;

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const searchParams = request.nextUrl.searchParams;
    const status = (searchParams.get("status") || "PENDING").toUpperCase();
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));

    const where = { status: status as any };

    const [transactions, total, pendingCount, stuckCount, investigatingCount] =
      await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            viewer: { select: { id: true, displayName: true, email: true, phone: true } },
            video: { select: { id: true, title: true } },
            creator: { select: { id: true, displayName: true } },
          },
        }),
        prisma.transaction.count({ where }),
        prisma.transaction.count({ where: { status: "PENDING" } }),
        prisma.transaction.count({
          where: {
            status: "PENDING",
            createdAt: { lt: new Date(Date.now() - STUCK_MINUTES * 60_000) },
          },
        }),
        // Charges the sweeper could neither confirm nor deny. Money may already
        // have left a customer's handset, so this count is the one that needs a
        // human — it drives the badge on the admin Payments tab.
        prisma.transaction.count({ where: { status: "UNDER_INVESTIGATION" } }),
      ]);

    const now = Date.now();

    return api.success({
      transactions: transactions.map((tx) => ({
        ...tx,
        ageMinutes: Math.floor((now - tx.createdAt.getTime()) / 60_000),
        stuck:
          tx.status === "PENDING" &&
          now - tx.createdAt.getTime() > STUCK_MINUTES * 60_000,
      })),
      summary: {
        pending: pendingCount,
        stuck: stuckCount,
        investigating: investigatingCount,
        stuckAfterMinutes: STUCK_MINUTES,
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payments Error]", error);
    return api.internal();
  }
}

const actionSchema = z.object({
  // Defaulted for backward compatibility with clients that only ever sent
  // { transactionId } to force-expire.
  action: z
    .enum(["expire", "recheck", "grant", "mark_unpaid", "refund"])
    .default("expire"),
  transactionId: z.string().min(1),
  reason: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  // --- refund only ---------------------------------------------------------
  // WALLET: we return the money ourselves, as spendable balance (automatic).
  // GATEWAY: the operator reversed it in the HarakaPay dashboard and must supply
  // the reference — HarakaPay has no reversal API, so that reference is the only
  // evidence the network leg happened.
  destination: z.enum(["WALLET", "GATEWAY"]).optional(),
  gatewayRef: z.string().trim().max(120).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const raw = await request.json().catch(() => ({}));
    const result = actionSchema.safeParse(raw);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { action, transactionId, reason, note, destination, gatewayRef } =
      result.data;

    switch (action) {
      case "refund": {
        const outcome = await reverseCollectedCharge({
          transactionId,
          destination: destination ?? "WALLET",
          actorId: auth.userId,
          reason,
          gatewayRef,
        });

        if (!outcome.ok) {
          switch (outcome.reason) {
            case "not_found":
              return api.notFound("Charge not found");
            case "already_refunded":
              return api.error("This charge has already been refunded.", 409, "ALREADY_REFUNDED");
            case "gateway_ref_required":
              return api.error(
                "HarakaPay has no reversal API, so a reversal to the customer's phone must be done in their dashboard. Paste the reversal reference from there so it is on the record.",
                400,
                "GATEWAY_REF_REQUIRED"
              );
            case "wallet_refund_of_topup":
              return api.error(
                "A top-up is already wallet credit — refunding it to the wallet would pay the customer twice. Send it back to their phone instead.",
                400,
                "WALLET_REFUND_OF_TOPUP"
              );
            case "insufficient_wallet":
              return api.error(
                `This top-up credit has already been spent, so it cannot be taken back: ${outcome.detail}.`,
                409,
                "INSUFFICIENT_WALLET"
              );
            default:
              return api.error(
                `Money can only be returned from a charge we hold — this one is ${outcome.status}.`,
                409,
                "NOT_REVERSIBLE"
              );
          }
        }

        const money =
          outcome.destination === "WALLET"
            ? `TZS ${outcome.walletCredited.toLocaleString("en-US")} credited to the customer's wallet`
            : `TZS ${outcome.amount.toLocaleString("en-US")} marked as returned to the customer's phone`;

        const clawedBack = outcome.clawedBackPending + outcome.clawedBackAvailable;
        const creatorLeg = !outcome.settledBefore
          ? "The creator's share was left alone: this charge never settled in our books, so they were never credited for it."
          : outcome.shortfall > 0
            ? `TZS ${clawedBack.toLocaleString("en-US")} of the creator's share was taken back, and TZS ${outcome.shortfall.toLocaleString("en-US")} had already been paid out so it is recorded as a platform loss.`
            : `TZS ${clawedBack.toLocaleString("en-US")} of the creator's share was taken back.`;

        return api.success({
          transactionId,
          amount: outcome.amount,
          destination: outcome.destination,
          settledBefore: outcome.settledBefore,
          walletCredited: outcome.walletCredited,
          walletDebited: outcome.walletDebited,
          clawedBack,
          shortfall: outcome.shortfall,
          revoked: outcome.revoked,
          message: `Reversed — ${money}. ${creatorLeg}`,
        });
      }

      case "recheck": {
        const outcome = await recheckPaymentCharge(transactionId);
        if (!outcome.ok) {
          if (outcome.reason === "not_found") return api.notFound("Charge not found");
          if (outcome.reason === "no_provider_ref") {
            return api.error(
              "This charge has no gateway order id, so there is nothing to ask the gateway about.",
              409,
              "NO_PROVIDER_REF"
            );
          }
          return api.error(
            "This charge is already final — nothing to re-check.",
            409,
            "ALREADY_FINAL"
          );
        }
        if (outcome.gatewayError) {
          return api.success({
            transactionId,
            status: outcome.status,
            gatewayStatus: null,
            settled: false,
            gatewayError: outcome.gatewayError,
            message: `Could not ask HarakaPay: ${outcome.gatewayError}. Nothing changed — the charge stays under investigation.`,
          });
        }

        return api.success({
          transactionId,
          status: outcome.status,
          gatewayStatus: outcome.gatewayStatus,
          settled: outcome.settled,
          message: outcome.settled
            ? "The gateway had a verdict — the charge is now settled."
            : `The gateway still reports "${outcome.gatewayStatus ?? "unknown"}". Nothing changed; keep checking with the network.`,
        });
      }

      case "grant": {
        const outcome = await resolveInvestigation({
          transactionId,
          outcome: "GRANT",
          actorId: auth.userId,
          note,
        });
        if (!outcome.ok) {
          if (outcome.reason === "not_found") return api.notFound("Charge not found");
          return api.error(
            `This charge is not under investigation (currently: ${outcome.status}).`,
            409,
            "NOT_UNDER_INVESTIGATION"
          );
        }
        return api.success({
          transactionId,
          amount: outcome.amount,
          message:
            "Marked as paid — the customer's purchase is unlocked and the creator's 70% share is recorded.",
        });
      }

      case "mark_unpaid": {
        const outcome = await resolveInvestigation({
          transactionId,
          outcome: "MARK_UNPAID",
          actorId: auth.userId,
          note,
        });
        if (!outcome.ok) {
          if (outcome.reason === "not_found") return api.notFound("Charge not found");
          return api.error(
            `This charge is not under investigation (currently: ${outcome.status}).`,
            409,
            "NOT_UNDER_INVESTIGATION"
          );
        }
        return api.success({
          transactionId,
          amount: outcome.amount,
          message:
            "Marked as not paid — the customer has been told it is safe to retry, and a late settlement would still be honoured.",
        });
      }

      default: {
        const outcome = await expirePaymentCharge({
          transactionId,
          reason: reason || "admin_force_expire",
          actorId: auth.userId,
        });

        if (!outcome.ok) {
          if (outcome.reason === "not_found") return api.notFound("Charge not found");
          return api.error(
            `This charge is not in a releasable state (currently: ${outcome.status}).`,
            409,
            "NOT_PENDING"
          );
        }

        return api.success({
          transactionId,
          amount: outcome.amount,
          message: "Charge released — the customer can try again",
        });
      }
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payments Action Error]", error);
    return api.internal();
  }
}
