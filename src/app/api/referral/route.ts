// =============================================================================
// GENHUB - Referral / Affiliate API Route
// GET /api/referral - My referral code, link, and earnings
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";

function makeCode(displayName: string | null): string {
  const base = (displayName || "GEN")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base || "GEN"}${rand}`;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    let user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        id: true,
        referralCode: true,
        referralEarnings: true,
        displayName: true,
        _count: { select: { referrals: true } },
      },
    });
    if (!user) return api.notFound("This user does not exist");

    // Lazily generate a unique referral code on first visit
    if (!user.referralCode) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = makeCode(user.displayName);
        const clash = await prisma.user.findUnique({
          where: { referralCode: candidate },
          select: { id: true },
        });
        if (!clash) {
          await prisma.user.update({
            where: { id: user.id },
            data: { referralCode: candidate },
          });
          user = { ...user, referralCode: candidate };
          break;
        }
      }
    }

    // Conversion history: who joined with my code (most recent first)
    const referrals = await prisma.user.findMany({
      where: { referredById: user.id },
      select: { id: true, displayName: true, avatarUrl: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return api.success({
      code: user.referralCode,
      link: user.referralCode
        ? `${config.appUrl}/register?ref=${user.referralCode}`
        : null,
      referredCount: user._count.referrals,
      referralEarnings: user.referralEarnings,
      rewardPerReferral: 1000,
      referrals: referrals.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        joinedAt: r.createdAt,
        bonus: 1000,
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Referral Error]", error);
    return api.internal();
  }
}
