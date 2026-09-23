// =============================================================================
// GENHUB - Creator Payout Request Route
// POST /api/creator/payouts - Request payout
// GET /api/creator/payouts - List payout history
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { requestPayoutSchema } from "@/lib/validation";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const body = await request.json();
    const result = requestPayoutSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { amount, paymentMethod, accountDetails, bankName } = result.data;

    // Check KYC status
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { kycStatus: true },
    });

    if (user?.kycStatus !== "APPROVED") {
      return api.forbidden("Your KYC must be approved before you can withdraw");
    }

    // Check available balance
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: auth.userId },
    });

    if (!balance || balance.availableBalance < config.business.minPayoutAmount) {
      return api.error(
        `Your balance is too low. The minimum payout is TZS ${config.business.minPayoutAmount.toLocaleString()}`,
        400
      );
    }

    if (amount > balance.availableBalance) {
      return api.error(
        `Balance mismatch. Your balance is TZS ${balance.availableBalance.toLocaleString()}`,
        400
      );
    }

    // Check for pending payout requests
    const pendingPayout = await prisma.payoutRequest.findFirst({
      where: {
        creatorId: auth.userId,
        status: { in: ["PENDING", "APPROVED"] },
      },
    });

    if (pendingPayout) {
      return api.error("A withdrawal request is already in progress. Please wait.", 409);
    }

    // Deduct from available balance and create payout request
    const payout = await prisma.$transaction(async (tx) => {
      await tx.creatorBalance.update({
        where: { creatorId: auth.userId },
        data: { availableBalance: { decrement: amount } },
      });

      return tx.payoutRequest.create({
        data: {
          creatorId: auth.userId,
          amount,
          paymentMethod,
          accountDetails,
          bankName,
          status: "PENDING",
        },
      });
    });

    return api.success(payout, "Withdrawal request submitted", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Payout Request Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const payouts = await prisma.payoutRequest.findMany({
      where: { creatorId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return api.success(payouts);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Payout History Error]", error);
    return api.internal();
  }
}
