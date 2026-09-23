// =============================================================================
// GENHUB - Wallet Transaction History API Route
// GET /api/wallet/transactions - the signed-in user's wallet history
// (top-ups, purchases, tips, subscription and referral rows where they are
// the payer/recipient). The wallet page has always called this endpoint —
// it was simply missing, so the list rendered as "No transactions yet".
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(_request: NextRequest) {
  try {
    const auth = await requireAuth();

    const transactions = await prisma.transaction.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        video: { select: { id: true, title: true, slug: true } },
        creator: { select: { id: true, displayName: true } },
      },
    });

    return api.success(transactions);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Wallet Transactions Error]", error);
    return api.internal();
  }
}
