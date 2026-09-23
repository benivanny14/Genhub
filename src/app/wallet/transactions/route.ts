// =============================================================================
// GENHUB - Wallet Transactions Route
// GET /api/wallet/transactions
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const transactions = await prisma.transaction.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        amount: true,
        type: true,
        status: true,
        gateway: true,
        createdAt: true,
        video: {
          select: { title: true },
        },
      },
    });

    return api.success(transactions);
  } catch (error) {
    console.error("[Wallet Transactions Error]", error);
    return api.internal();
  }
}
