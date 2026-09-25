// =============================================================================
// GENHUB - Admin Stats/Overview API Route
// GET /api/admin/overview - Aggregate platform metrics
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { cacheGet, cacheSet } from "@/lib/redis";
import { getChatRevenue } from "@/lib/services/paid-message.service";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    // Check cache (refresh every 2 minutes)
    const cacheKey = "admin:overview";
    const cached = await cacheGet(cacheKey);
    if (cached) return api.success(cached);

    // Run all counts in parallel
    const [
      totalUsers,
      totalCreators,
      totalViewers,
      totalAdmins,
      bannedUsers,
      pendingKyc,
      totalVideos,
      publishedVideos,
      flaggedVideos,
      totalTransactions,
      pendingPayouts,
      revenueAgg,
      todayRevenue,
      videoViewsAgg,
      recentUsers,
      topCreators,
      usersByRole,
      transactionsByType,
      chatRevenue,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: "CREATOR" } }),
      prisma.user.count({ where: { role: "VIEWER" } }),
      prisma.user.count({ where: { role: "ADMIN" } }),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.kycVerification.count({ where: { status: "PENDING" } }),
      prisma.video.count({ where: { isDeleted: false } }),
      prisma.video.count({ where: { isPublished: true, isDeleted: false } }),
      prisma.video.count({ where: { isFlagged: true } }),
      prisma.transaction.count({ where: { status: "SUCCESS" } }),
      prisma.payoutRequest.count({ where: { status: "PENDING" } }),
      prisma.transaction.aggregate({
        where: { status: "SUCCESS" },
        _sum: { amount: true, platformFee: true, creatorCut: true },
      }),
      prisma.transaction.aggregate({
        where: {
          status: "SUCCESS",
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        _sum: { amount: true },
      }),
      prisma.video.aggregate({
        where: { isDeleted: false },
        _sum: { viewsCount: true },
      }),
      // Recent users (last 10)
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          displayName: true,
          role: true,
          isBanned: true,
          createdAt: true,
        },
      }),
      // Top creators by total earned
      prisma.creatorBalance.findMany({
        orderBy: { totalEarned: "desc" },
        take: 10,
        include: {
          creator: {
            select: { id: true, displayName: true, avatarUrl: true, strikes: true },
          },
        },
      }),
      // Users grouped by role
      prisma.user.groupBy({
        by: ["role"],
        _count: true,
      }),
      // Transactions grouped by type
      prisma.transaction.groupBy({
        by: ["type"],
        _count: true,
        _sum: { amount: true },
        where: { status: "SUCCESS" },
      }),
      // Chat revenue comes from the ledger, not from the transaction-type totals
      // above: a paid message and a plain tip are both TIP transactions, and this
      // card is about messages only.
      getChatRevenue(),
    ]);

    // Active subscriptions count
    const activeSubscriptions = await prisma.creatorSubscription.count({
      where: { isActive: true, expiresAt: { gt: new Date() } },
    });

    // Favorites count
    const totalFavorites = await prisma.favorite.count();

    const result = {
      users: {
        total: totalUsers,
        creators: totalCreators,
        viewers: totalViewers,
        admins: totalAdmins,
        banned: bannedUsers,
        recent: recentUsers,
      },
      kyc: {
        pending: pendingKyc,
      },
      videos: {
        total: totalVideos,
        published: publishedVideos,
        flagged: flaggedVideos,
      },
      transactions: {
        total: totalTransactions,
        totalAmount: revenueAgg._sum.amount || 0,
        totalPlatformFees: revenueAgg._sum.platformFee || 0,
        totalCreatorPayouts: revenueAgg._sum.creatorCut || 0,
        todayAmount: todayRevenue._sum.amount || 0,
        byType: transactionsByType,
      },
      payouts: {
        pending: pendingPayouts,
      },
      engagement: {
        totalViews: videoViewsAgg._sum.viewsCount || 0,
        activeSubscriptions,
        totalFavorites,
      },
      topCreators: topCreators.map((b) => ({
        ...b.creator,
        totalEarned: b.totalEarned,
        pendingBalance: b.pendingBalance,
        availableBalance: b.availableBalance,
      })),
      chatRevenue,
      overview: {
        platformRevenue: revenueAgg._sum.platformFee || 0,
        creatorEarnings: revenueAgg._sum.creatorCut || 0,
        revenueSplit: {
          platform: 30,
          creator: 70,
        },
      },
    };

    await cacheSet(cacheKey, result, 120); // Cache 2 minutes

    return api.success(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Overview Error]", error);
    return api.internal();
  }
}
