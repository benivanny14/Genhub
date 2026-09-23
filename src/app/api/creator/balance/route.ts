// =============================================================================
// GENHUB - Creator Balance & Earnings Route
// GET /api/creator/balance - Get balance breakdown and earnings history
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Release any earnings that just passed the 14-day holding period so the
    // dashboard always shows current numbers (idempotent + cheap: 1-2 queries).
    try {
      await releaseMatureEarnings(auth.userId);
    } catch (releaseError) {
      console.warn("[Balance] Release check failed:", (releaseError as Error)?.message);
    }

    // Get balance
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: auth.userId },
    });

    // Get video performance stats
    const videoStats = await prisma.video.findMany({
      where: { creatorId: auth.userId, isDeleted: false },
      select: {
        id: true,
        title: true,
        viewsCount: true,
        purchaseCount: true,
        price: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Get earnings per video
    const videoEarnings = await prisma.videoEarning.findMany({
      where: {
        video: { creatorId: auth.userId },
      },
      select: {
        videoId: true,
        totalEarned: true,
        totalPurchases: true,
      },
    });

    // Merge stats with earnings
    const enrichedVideos = videoStats.map((v) => ({
      ...v,
      totalEarned: videoEarnings.find((e) => e.videoId === v.id)?.totalEarned || 0,
    }));

    // Today's earnings
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTransactions = await prisma.transaction.aggregate({
      where: {
        creatorId: auth.userId,
        status: "SUCCESS",
        createdAt: { gte: today },
      },
      _sum: { creatorCut: true },
    });

    // Total views
    const totalViews = videoStats.reduce((sum, v) => sum + v.viewsCount, 0);

    // Recent transactions
    const recentTransactions = await prisma.transaction.findMany({
      where: {
        creatorId: auth.userId,
        status: "SUCCESS",
      },
      select: {
        id: true,
        amount: true,
        creatorCut: true,
        type: true,
        createdAt: true,
        video: { select: { title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return api.success({
      balance: balance || {
        pendingBalance: 0,
        availableBalance: 0,
        totalEarned: 0,
      },
      todayEarnings: todayTransactions._sum.creatorCut || 0,
      totalViews,
      videoStats: enrichedVideos,
      recentTransactions,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Creator Balance Error]", error);
    return api.internal();
  }
}
