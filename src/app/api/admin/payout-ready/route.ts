// =============================================================================
// GENHUB - Admin: who is holding money, and who can withdraw it
// GET /api/admin/payout-ready
//
// Every creator with money in their withdrawable balance, in one list. It used
// to be only the ones at or above the withdrawal floor
// (config.business.minPayoutAmount, TZS 30,000), which made the page lie about
// the people it exists to describe: a creator holding TZS 2,450 is money the
// platform owes, and with the floor on they cannot take it out — so the one
// screen where an operator could hand them a smaller withdrawal showed an empty
// list and a total of zero. They are listed now, under `belowFloor`, with the
// floor they have not reached; the waiver that lets them withdraw anyway
// (User.payoutMinimumWaived) is on their row.
//
// `readyCount`/`readyAmount` still mean "at the floor", so the badge and the
// money that is about to leave are read the same way as before, and
// `totalAmount` is what the platform is holding for everybody.
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
      // Anyone holding anything. A balance of zero is not a queue: there is
      // nothing to withdraw and nothing to decide.
      where: { availableBalance: { gt: 0 } },
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
        // True when they reached the floor — the normal way to withdraw.
        atMinimum: r.availableBalance >= minimum,
        // Below the floor and not yet allowed to ignore it: this is the account
        // the admin has to make a decision about, and the reason the list no
        // longer hides it.
        belowFloor: r.availableBalance < minimum && !r.creator.payoutMinimumWaived,
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
        // At the floor: the money that can leave without an admin doing
        // anything. Kept separate so "ready" keeps its old meaning.
        readyCount: creators.filter((c) => c.atMinimum).length,
        readyAmount: creators
          .filter((c) => c.atMinimum)
          .reduce((sum, c) => sum + c.availableBalance, 0),
        // Under the floor and not waived: held until they grow, or until an
        // admin allows a smaller withdrawal.
        belowFloorCount: creators.filter((c) => c.belowFloor).length,
        belowFloorAmount: creators
          .filter((c) => c.belowFloor)
          .reduce((sum, c) => sum + c.availableBalance, 0),
        // Everyone the platform owes money to, frozen accounts included.
        totalCount: creators.length,
        totalAmount: creators.reduce((sum, c) => sum + c.availableBalance, 0),
        frozenCount: creators.filter((c) => c.frozen).length,
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
