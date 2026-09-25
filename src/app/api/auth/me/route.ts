// =============================================================================
// GENHUB - Get Current User API Route
// GET /api/auth/me
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) {
      return api.unauthorized();
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: {
        id: true,
        displayName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
        kycStatus: true,
        isBanned: true,
        strikes: true,
        walletBalance: true,
        locale: true,
        referralCode: true,
        referralEarnings: true,
        createdAt: true,
        creatorBalance: {
          select: {
            pendingBalance: true,
            availableBalance: true,
            totalEarned: true,
          },
        },
      },
    });

    if (!user) {
      // 401, not 404. This endpoint answers exactly one question — "who is signed
      // in?" — and for a token naming a user who no longer exists the answer is
      // "nobody". A 404 described it as a missing resource, so a client had to
      // read a status that means "wrong URL" as "signed out", and every page's
      // guard treated the two the same by accident rather than on purpose.
      // It matters more now that erasing an account leaves its token behind.
      return api.unauthorized("This session is no longer valid — please sign in again");
    }

    return api.success(user);
  } catch (error) {
    console.error("[Get Me Error]", error);
    return api.internal();
  }
}
