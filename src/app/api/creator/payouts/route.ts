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
import { requestPayout } from "@/lib/services/payout.service";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const body = await request.json();
    const result = requestPayoutSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { amount, paymentMethod, accountDetails, bankName } = result.data;

    // Check KYC status and whether an admin has paused withdrawals. Both are
    // read once, together, because they answer the same question: may this
    // creator move money right now?
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { kycStatus: true, payoutFrozenUntil: true, payoutFrozenReason: true },
    });

    if (user?.kycStatus !== "APPROVED") {
      return api.forbidden("Your KYC must be approved before you can withdraw");
    }

    if (user.payoutFrozenUntil && user.payoutFrozenUntil > new Date()) {
      const until = user.payoutFrozenUntil.toLocaleDateString("en-GB");
      return api.forbidden(
        `Your withdrawals are paused until ${until}` +
          (user.payoutFrozenReason ? `: ${user.payoutFrozenReason}` : ".")
      );
    }

    // Every balance check and the deduction live in requestPayout, where they
    // are one statement. Doing the comparison here and the `decrement` there is
    // how two requests arriving together both pass a check that was only true a
    // moment earlier.
    const outcome = await requestPayout({
      creatorId: auth.userId,
      amount,
      paymentMethod,
      accountDetails,
      bankName,
    });

    if (!outcome.ok) {
      const minimum = outcome.minimum.toLocaleString();

      if (outcome.reason === "AMOUNT_BELOW_MINIMUM") {
        return api.error(`The minimum withdrawal is TZS ${minimum}`, 400);
      }

      if (outcome.reason === "BALANCE_BELOW_MINIMUM") {
        return api.error(
          `Your balance is too low. The minimum payout is TZS ${minimum}`,
          400
        );
      }

      if (outcome.reason === "ALREADY_PENDING") {
        return api.error("A withdrawal request is already in progress. Please wait.", 409);
      }

      return api.error(
        `Balance mismatch. Your balance is TZS ${outcome.availableBalance.toLocaleString()}`,
        400
      );
    }

    return api.success(
      {
        id: outcome.payoutId,
        creatorId: auth.userId,
        amount: outcome.amount,
        paymentMethod,
        accountDetails,
        bankName: bankName ?? null,
        status: "PENDING",
      },
      "Withdrawal request submitted",
      201
    );
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
