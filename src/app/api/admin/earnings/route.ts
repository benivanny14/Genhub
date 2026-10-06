// =============================================================================
// GENHUB - Admin Earnings Dashboard API
// GET  /api/admin/earnings - Creator balances, and what is still held
// POST /api/admin/earnings - Release held balances (all creators or one)
//
// There is no holding period: a sale is withdrawable the moment it settles, so
// `availableBalance` is the money a creator can ask for right now. Anything
// still in `pendingBalance` is a leftover from before that rule changed, and is
// releasable in full — that is what POST does.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

export async function GET(_request: NextRequest) {
  try {
    await requireRole("ADMIN");

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

    // One row per creator, with no second query per creator: what is held IS the
    // ready amount. The old version recomputed matured earnings per row (an
    // aggregate per creator) to decide how much of the bucket could move, which
    // is both slower and, as it turned out, wrong for any credit without a
    // backing transaction.
    const rows = balances.map((b) => ({
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
      readyToRelease: b.pendingBalance,
    }));

    const totals = rows.reduce(
      (acc, r) => ({
        pending: acc.pending + r.pendingBalance,
        available: acc.available + r.availableBalance,
        released: acc.released + r.releasedTotal,
        ready: acc.ready + r.readyToRelease,
      }),
      { pending: 0, available: 0, released: 0, ready: 0 }
    );

    return api.success({ creators: rows, totals });
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

    const body = await readJsonBody(request, {});
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
