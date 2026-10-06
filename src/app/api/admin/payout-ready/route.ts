// =============================================================================
// GENHUB - Admin: creators ready to withdraw
// GET /api/admin/payout-ready
//
// The money the platform is about to part with, in one list. A creator appears
// here the moment their available balance reaches the withdrawal floor
// (config.business.minPayoutAmount, TZS 30,000) — the point at which they can ask
// for a payout — so an operator can watch the queue instead of finding it.
//
// Also lists creators whose floor an admin has waived (User.payoutMinimumWaived)
// and who hold something: those cannot be seen through the TZS 30,000 lens, and
// leaving them out would make the list lie about who can withdraw.
//
// Read-only. The actions live on the user route (WAIVE_PAYOUT_MINIMUM,
// FREEZE_PAYOUTS, …) and on the payout queue, so this cannot move money by
// itself.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(_request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const minimum = config.business.minPayoutAmount;
    const now = new Date();

    const rows = await prisma.creatorBalance.findMany({
      where: {
        OR: [
          { availableBalance: { gte: minimum } },
          // Below the floor, but an admin has let this account withdraw anyway.
          { availableBalance: { gt: 0 }, creator: { payoutMinimumWaived: true } },
        ],
      },
      orderBy: { availableBalance: "desc" },
      take: 100,
      include: {
        creator: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            role: true,
            isVerified: true,
            kycStatus: true,
            isBanned: true,
            payoutFrozenUntil: true,
            payoutFrozenReason: true,
            payoutMinimumWaived: true,
          },
        },
      },
    });

    // Open withdrawal requests, so a row answers "can they actually take this
    // out?" — a creator with one already in flight should not be re-reviewed.
    const ids = rows.map((r) => r.creatorId);
    const open = ids.length
      ? await prisma.payoutRequest.groupBy({
          by: ["creatorId"],
          where: { creatorId: { in: ids }, status: { in: ["PENDING", "APPROVED"] } },
          _count: { _all: true },
        })
      : [];
    const openByCreator = new Map(open.map((o) => [o.creatorId, o._count._all]));

    const creators = rows.map((r) => {
      const frozen = Boolean(r.creator.payoutFrozenUntil && r.creator.payoutFrozenUntil > now);
      return {
        creatorId: r.creatorId,
        displayName: r.creator.displayName,
        email: r.creator.email,
        avatarUrl: r.creator.avatarUrl,
        isVerified: r.creator.isVerified,
        isBanned: r.creator.isBanned,
        kycStatus: r.creator.kycStatus,
        availableBalance: r.availableBalance,
        totalEarned: r.totalEarned,
        // True when they reached the floor — the normal way to be on this list.
        atMinimum: r.availableBalance >= minimum,
        payoutMinimumWaived: r.creator.payoutMinimumWaived,
        frozen,
        payoutFrozenUntil: r.creator.payoutFrozenUntil?.toISOString() ?? null,
        payoutFrozenReason: r.creator.payoutFrozenReason,
        openRequests: openByCreator.get(r.creatorId) ?? 0,
        // What this creator needs before they can withdraw, so the list can sort
        // "ready now" from "ready because an admin allowed it" without the client
        // re-deriving the rule.
        canWithdraw: frozen
          ? false
          : r.availableBalance >= minimum || r.creator.payoutMinimumWaived,
      };
    });

    return api.success({
      creators,
      minimum,
      totals: {
        readyCount: creators.filter((c) => c.atMinimum).length,
        readyAmount: creators
          .filter((c) => c.atMinimum)
          .reduce((sum, c) => sum + c.availableBalance, 0),
        totalCount: creators.length,
        totalAmount: creators.reduce((sum, c) => sum + c.availableBalance, 0),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payout Ready Error]", error);
    return api.internal();
  }
}
