// =============================================================================
// GENHUB - Creator Analytics API Route
// GET /api/creator/analytics - Aggregated stats for the creator dashboard
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const [
      videoStats,
      balance,
      subscribers,
      recentTx,
      topVideos,
      payoutTotal,
      topFansRaw,
      viewersAllTime,
      viewers30d,
      subscribers30d,
    ] = await Promise.all([
      prisma.video.aggregate({
        where: { creatorId: auth.userId, isPublished: true, isDeleted: false },
        _count: { id: true },
        _sum: { viewsCount: true, likesCount: true, purchaseCount: true },
      }),
      prisma.creatorBalance.findUnique({ where: { creatorId: auth.userId } }),
      prisma.creatorSubscription.count({
        where: {
          creatorId: auth.userId,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
      }),
      prisma.transaction.findMany({
        where: {
          creatorId: auth.userId,
          status: "SUCCESS",
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { amount: true, creatorCut: true, type: true, createdAt: true },
      }),
      prisma.video.findMany({
        where: { creatorId: auth.userId, isPublished: true, isDeleted: false },
        orderBy: { viewsCount: "desc" },
        take: 5,
        select: {
          id: true,
          title: true,
          slug: true,
          viewsCount: true,
          likesCount: true,
          purchaseCount: true,
          price: true,
        },
      }),
      prisma.payoutRequest.aggregate({
        where: { creatorId: auth.userId, status: { in: ["PENDING", "APPROVED"] } },
        _sum: { amount: true },
      }),
      // Fan leaderboard — top spenders (lifetime)
      prisma.transaction.groupBy({
        by: ["userId"],
        where: { creatorId: auth.userId, status: "SUCCESS" },
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { _sum: { amount: "desc" } },
        take: 5,
      }),
      // HOW MANY PEOPLE, not how many times. `viewsCount` is a per-viewer,
      // per-hour event counter: one fan watching on Monday and again on Tuesday
      // adds two. That is the right input for ranking and the wrong answer to
      // "how many viewers do I have" — a creator cannot tell five people apart
      // from one person five times, cannot see churn, and cannot price a
      // subscription on it. WatchProgress is keyed `(userId, videoId)`, so one
      // grouped row per viewer is exactly a distinct person who actually
      // started a scene (only entitled viewers reach the player, so this cannot
      // count paywall hits as viewers).
      prisma.watchProgress.groupBy({
        by: ["userId"],
        where: { video: { creatorId: auth.userId } },
      }),
      prisma.watchProgress.groupBy({
        by: ["userId"],
        where: {
          video: { creatorId: auth.userId },
          updatedAt: { gte: thirtyDaysAgo },
        },
      }),
      // Subscribers GAINED in the window. The active count alone says how many
      // are paying now and nothing about direction: a creator renewing 40 people
      // while losing 40 sees a flat line and no reason for it.
      prisma.creatorSubscription.count({
        where: { creatorId: auth.userId, createdAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    // Bucket the last 30 days into daily revenue (creator's cut only)
    const daily: { date: string; revenue: number; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      daily.push({
        date: d.toISOString().slice(0, 10),
        revenue: 0,
        count: 0,
      });
    }
    const dayIndex = new Map(daily.map((d, i) => [d.date, i]));

    const byType: Record<string, number> = {
      PPV_PURCHASE: 0,
      SUBSCRIPTION: 0,
      TIP: 0,
      OTHER: 0,
    };
    let totalRevenue30d = 0;

    for (const tx of recentTx) {
      const key = tx.createdAt.toISOString().slice(0, 10);
      const idx = dayIndex.get(key);
      const cut = tx.creatorCut ?? tx.amount;
      if (idx !== undefined) {
        daily[idx].revenue += cut;
        daily[idx].count += 1;
      }
      totalRevenue30d += cut;
      const type = byType[tx.type] !== undefined ? tx.type : "OTHER";
      byType[type] = (byType[type] || 0) + cut;
    }

    const totalViews = videoStats._sum.viewsCount || 0;
    const totalPurchases = videoStats._sum.purchaseCount || 0;

    // Resolve fan display names
    const fanIds = topFansRaw.map((f) => f.userId);
    const fanUsers = fanIds.length
      ? await prisma.user.findMany({
          where: { id: { in: fanIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const topFans = topFansRaw.map((f) => ({
      userId: f.userId,
      displayName:
        fanUsers.find((u) => u.id === f.userId)?.displayName || "Anonymous fan",
      avatarUrl: fanUsers.find((u) => u.id === f.userId)?.avatarUrl || null,
      totalSpent: f._sum.amount || 0,
      purchases: f._count._all,
    }));

    return api.success({
      totals: {
        publishedVideos: videoStats._count.id || 0,
        totalViews,
        totalLikes: videoStats._sum.likesCount || 0,
        totalPurchases,
        pendingBalance: balance?.pendingBalance || 0,
        availableBalance: balance?.availableBalance || 0,
        lifetimeEarned: balance?.totalEarned || 0,
        subscribers,
        subscribers30d,
        // Distinct people, not events — see the groupBy above.
        uniqueViewers: viewersAllTime.length,
        viewers30d: viewers30d.length,
        revenue30d: totalRevenue30d,
        pendingPayouts: payoutTotal._sum.amount || 0,
        conversionRate:
          totalViews > 0
            ? Math.round((totalPurchases / totalViews) * 1000) / 10
            : 0,
      },
      daily,
      byType,
      topVideos,
      topFans,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Creator Analytics Error]", error);
    return api.internal();
  }
}
