// =============================================================================
// GENHUB - Payout requests
//
// Moving a creator's available balance into a payout request, safely.
//
// This lived in the route, as: read `availableBalance`, compare it to the
// requested amount in JavaScript, then `decrement`. `decrement` is relative, so
// the comparison decided nothing — it only described what was true a moment
// earlier. Two requests arriving together both read the old balance, both
// passed, and both decremented: the creator could queue two payouts for money
// the platform does not hold, and the balance went negative rather than
// refusing. Payouts are the one flow where the loss is real cash leaving, so the
// check is now part of the write (see debitWallet in balance.service.ts for the
// measured version of that bug).
//
// The "one request at a time" rule stays as a fast path for a clear message, but
// it is not what protects the money: the conditional debit is.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { Prisma } from "@prisma/client";

export type PayoutRequestMethod = "MPESA" | "TIGO_PESA" | "AIRTEL_MONEY" | "BANK_TRANSFER";

export type PayoutRequestOutcome =
  | { ok: true; payoutId: string; amount: number; availableBalance: number }
  | {
      ok: false;
      reason:
        | "AMOUNT_BELOW_MINIMUM"
        | "BALANCE_BELOW_MINIMUM"
        | "INSUFFICIENT_BALANCE"
        | "ALREADY_PENDING";
      /** What the creator actually has, so the message can say the real number. */
      availableBalance: number;
      minimum: number;
    };

export interface PayoutRequestParams {
  creatorId: string;
  amount: number;
  paymentMethod: PayoutRequestMethod;
  /** Phone number or bank account — required by the schema, and by the payer. */
  accountDetails: string;
  bankName?: string | null;
}

async function availableBalanceOf(
  tx: Prisma.TransactionClient,
  creatorId: string
): Promise<number> {
  const balance = await tx.creatorBalance.findUnique({
    where: { creatorId },
    select: { availableBalance: true },
  });
  return balance?.availableBalance ?? 0;
}

export async function requestPayout(params: PayoutRequestParams): Promise<PayoutRequestOutcome> {
  const { creatorId, amount, paymentMethod, accountDetails, bankName } = params;
  const minimum = config.business.minPayoutAmount;

  return prisma.$transaction(async (tx) => {
    const availableBalance = await availableBalanceOf(tx, creatorId);

    // Answered before the balance, deliberately. A creator with a request
    // already in flight usually also has a low balance — the money is earmarked
    // — and telling them their balance is too low invites them to top up and try
    // again, when the only thing they need to do is wait.
    const alreadyPending = await tx.payoutRequest.findFirst({
      where: { creatorId, status: { in: ["PENDING", "APPROVED"] } },
      select: { id: true },
    });

    if (alreadyPending) {
      return { ok: false as const, reason: "ALREADY_PENDING" as const, availableBalance, minimum };
    }

    if (amount < minimum) {
      return { ok: false as const, reason: "AMOUNT_BELOW_MINIMUM" as const, availableBalance, minimum };
    }

    if (availableBalance < minimum) {
      return { ok: false as const, reason: "BALANCE_BELOW_MINIMUM" as const, availableBalance, minimum };
    }

    // The guard and the deduction in one statement: the row only moves for one
    // caller, and the amount it needs is the amount it checks for.
    const taken = await tx.creatorBalance.updateMany({
      where: { creatorId, availableBalance: { gte: amount } },
      data: { availableBalance: { decrement: amount } },
    });

    const after = await availableBalanceOf(tx, creatorId);

    if (taken.count === 0) {
      return { ok: false as const, reason: "INSUFFICIENT_BALANCE" as const, availableBalance: after, minimum };
    }

    const payout = await tx.payoutRequest.create({
      data: {
        creatorId,
        amount,
        paymentMethod,
        accountDetails,
        bankName: bankName ?? null,
        status: "PENDING",
      },
      select: { id: true },
    });

    return { ok: true as const, payoutId: payout.id, amount, availableBalance: after };
  });
}
