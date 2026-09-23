// =============================================================================
// GENHUB - Admin Earnings Dashboard API
// GET  /api/admin/earnings - Creator balances with maturity breakdown
// POST /api/admin/earnings - Run the 14-day release job (all creators or one)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

export async function GET(_request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const cutoff = new Date(
      Date.now() - config.business.holdingPeriodDays * 86_400_000
    );

    const balances = await prisma.creatorBalance.findMany({
      include: {
        creator: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            isVerified: true,
            kycStatus: true,
          },
        },
      },
      orderBy: [{ pendingBalance: "desc" }, { totalEarned: "desc" }],
      take: 100,
    });

    const rows = await Promise.all(
      balances.map(async (b) => {
        const matured = await prisma.transaction.aggregate({
          where: {
            creatorId: b.creatorId,
            status: "SUCCESS",
            creatorCut: { not: null },
            createdAt: { lte: cutoff },
          },
          _sum: { creatorCut: true },
        });
        const maturedTotal = matured._sum.creatorCut ?? 0;
        const ready = Math.min(
          Math.max(0, maturedTotal - b.releasedTotal),
          b.pendingBalance
        );
        return {
          creatorId: b.creatorId,
          displayName: b.creator.displayName,
          email: b.creator.email,
          avatarUrl: b.creator.avatarUrl,
          isVerified: b.creator.isVerified,
          kycStatus: b.creator.kycStatus,
          pendingBalance: b.pendingBalance,
          availableBalance: b.availableBalance,
          releasedTotal: b.releasedTotal,
          totalEarned: b.totalEarned,
          maturedTotal,
          readyToRelease: ready,
        };
      })
    );

    const totals = rows.reduce(
      (acc, r) => ({
        pending: acc.pending + r.pendingBalance,
        available: acc.available + r.availableBalance,
        released: acc.released + r.releasedTotal,
        ready: acc.ready + r.readyToRelease,
      }),
      { pending: 0, available: 0, released: 0, ready: 0 }
    );

    return api.success({
      creators: rows,
      totals,
      holdingPeriodDays: config.business.holdingPeriodDays,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Earnings Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const body = await request.json().catch(() => ({}));
    const creatorId =
      typeof body?.creatorId === "string" && body.creatorId ? body.creatorId : undefined;

    const result = await releaseMatureEarnings(creatorId);

    return api.success(
      result,
      `Released TZS ${result.released.toLocaleString()} for ${result.creators} creator(s)`
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Release Earnings Error]", error);
    return api.internal();
  }
}
