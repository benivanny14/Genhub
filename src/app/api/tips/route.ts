// =============================================================================
// GENHUB - Tip Creator API Route
// POST /api/tips - Send a tip to a creator from wallet balance
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { debitWallet } from "@/lib/services/balance.service";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { z } from "zod";

const tipSchema = z.object({
  creatorId: z.string().min(1),
  amount: z.number().int().min(500, "The minimum tip is TZS 500").max(100000),
  message: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const { allowed } = await checkRateLimit(
      `tip:${auth.userId}`,
      config.rateLimit.payment.max,
      config.rateLimit.payment.windowMs
    );
    if (!allowed) return api.rateLimited("Please wait before sending another tip");

    const body = await request.json();
    const result = tipSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { creatorId, amount, message } = result.data;

    if (creatorId === auth.userId) {
      return api.error("You cannot tip yourself");
    }

    // Verify creator exists
    const creator = await prisma.user.findUnique({
      where: { id: creatorId, role: "CREATOR" },
      select: { id: true, isBanned: true },
    });
    if (!creator || creator.isBanned) return api.notFound("This creator does not exist");

    // Create tip transaction — 100% to creator. The balance check IS the
    // deduction (debitWallet): reading first and decrementing after let several
    // tips start on one balance and all be accepted.
    const transaction = await prisma.$transaction(async (tx) => {
      const debited = await debitWallet(tx, { userId: auth.userId, amount });
      if (!debited.ok) {
        return {
          insufficient: true as const,
          balance: debited.balance,
        };
      }

      // Create transaction
      const txRecord = await tx.transaction.create({
        data: {
          userId: auth.userId,
          creatorId,
          amount,
          type: "TIP",
          status: "SUCCESS",
          creatorCut: amount, // Tips are 100% to creator
        },
      });

      // Credit creator pending balance
      await tx.creatorBalance.upsert({
        where: { creatorId },
        create: {
          creatorId,
          pendingBalance: amount,
          availableBalance: 0,
          totalEarned: amount,
        },
        update: {
          pendingBalance: { increment: amount },
          totalEarned: { increment: amount },
        },
      });

      // Create notification for creator
      await tx.notification.create({
        data: {
          userId: creatorId,
          title: "New tip! 🎁",
          message: `A viewer tipped you TZS ${amount.toLocaleString()}${message ? `: "${message}"` : ""}`,
          type: "success",
        },
      });

      return txRecord;
    });

    // The debit refused: the tip never happened, so nothing was written. The
    // message names the real balance, because "too low" without a number is
    // what makes someone try the same amount again.
    if ("insufficient" in transaction) {
      return api.error(
        `Your wallet balance is too low (TZS ${transaction.balance.toLocaleString()}). Top up first.`
      );
    }

    return api.success(transaction, "Tip sent!");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Tip Error]", error);
    return api.internal();
  }
}
