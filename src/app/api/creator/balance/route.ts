// =============================================================================
// GENHUB - Creator Balance & Earnings Route
// GET /api/creator/balance - Get balance breakdown and earnings history
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";
import { getPaidMessageEarnings } from "@/lib/services/paid-message.service";

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

    // Recent transactions. `metadata` comes along so the dashboard can tell a
    // paid message from a plain tip — both are TIP transactions, and only one of
    // them came from the inbox.
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
        metadata: true,
        video: { select: { title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // The creator's own withdrawal requests, so the dashboard can show where the
    // money went — and, once a request is PAID, the receipt number the admin
    // typed. Without this the creator is told "paid" by a notification with
    // nothing to check it against, and the M-Pesa SMS is the only record they
    // hold. Capped like the transaction list: the dashboard is a glance, not a
    // statement.
    const payouts = await prisma.payoutRequest.findMany({
      where: { creatorId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        amount: true,
        paymentMethod: true,
        accountDetails: true,
        status: true,
        paymentReference: true,
        // Shown when a request is rejected: the reason is already sent as a
        // notification, but a notification is missed and a row is not.
        adminNote: true,
        createdAt: true,
        processedAt: true,
      },
    });

    // Chat income, on the same 14-day clock as everything else. Its own service
    // because the release job and this card have to agree about what is held.
    //
    // Null, not zeroes, if the read fails: an empty card would tell a creator
    // nobody has messaged them, which is a different statement from "we could not
    // read it". The balance and the videos on the same page are still answerable,
    // so this one card degrading must not blank all of them.
    let paidMessages = null;
    try {
      paidMessages = await getPaidMessageEarnings(auth.userId);
    } catch (messageError) {
      console.warn(
        "[Creator Balance] Paid-message read failed:",
        (messageError as Error)?.message
      );
    }

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
      payouts,
      paidMessages,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Creator Balance Error]", error);
    return api.internal();
  }
}
