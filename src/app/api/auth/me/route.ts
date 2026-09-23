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
      return api.notFound("This user no longer exists");
    }

    return api.success(user);
  } catch (error) {
    console.error("[Get Me Error]", error);
    return api.internal();
  }
}
