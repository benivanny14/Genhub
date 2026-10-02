// =============================================================================
// GENHUB - Admin signup cohorts
//
// GET /api/admin/analytics/cohorts — how many accounts that joined in each of
// the last N weeks are still active. The maths lives in lib/cohort-analytics.ts,
// where it is tested; this route bounds the query and hands the rows over.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { buildSignupCohorts } from "@/lib/cohort-analytics";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const params = request.nextUrl.searchParams;
    const retentionDays = Math.min(
      Math.max(Number(params.get("window")) || 30, 1),
      365
    );
    const maxCohorts = Math.min(Math.max(Number(params.get("weeks")) || 12, 1), 52);

    // Bounded both ways: only the window the chart shows, and only enough rows
    // to fill it. A cohort chart does not need every account ever created.
    const since = new Date(Date.now() - (maxCohorts + 1) * 7 * 86_400_000);
    const members = await prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: "asc" },
      take: 20_000,
    });

    const cohorts = buildSignupCohorts(
      members.map((m) => ({
        createdAt: m.createdAt.toISOString(),
        lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
      })),
      new Date(),
      { retentionDays, maxCohorts }
    );

    const totalMembers = cohorts.reduce((sum, c) => sum + c.size, 0);
    const totalRetained = cohorts.reduce((sum, c) => sum + c.retained, 0);

    return api.success({
      cohorts,
      retentionDays,
      totalMembers,
      overallRetentionRate: totalMembers === 0 ? 0 : totalRetained / totalMembers,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Cohorts Error]", error);
    return api.internal();
  }
}
