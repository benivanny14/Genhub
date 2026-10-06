// =============================================================================
// GENHUB - Creator Balance & Earnings Route
// GET /api/creator/balance - Get balance breakdown and earnings history
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";
import { getPaidMessageEarnings } from "@/lib/services/paid-message.service";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Release any balance still sitting in the legacy held bucket, so the
    // dashboard always shows current numbers (idempotent + cheap).
    try {
      await releaseMatureEarnings(auth.userId);
    } catch (releaseError) {
      console.warn("[Balance] Release check failed:", (releaseError as Error)?.message);
    }

    // Get balance
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: auth.userId },
    });

    // Whether an admin has waived the TZS 30,000 withdrawal floor for this
    // account, so the dashboard can say "you can withdraw any amount" instead of
    // showing a rule that no longer applies to them. The paused-withdrawals date
    // comes along because it is the same kind of fact about the same account —
    // and because a creator whose withdrawals are paused must be told that, not
    // walked into a form the payout route will refuse.
    const creatorFlags = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        payoutMinimumWaived: true,
        payoutFrozenUntil: true,
        payoutFrozenReason: true,
      },
    });
    // A date, not a flag: an expired freeze lifts itself, which is why this is
    // compared against the clock rather than read as a boolean.
    const payoutFrozen = Boolean(
      creatorFlags?.payoutFrozenUntil && creatorFlags.payoutFrozenUntil > new Date()
    );

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
        // The bank name belongs with the account details: it is half of where a
        // bank transfer has to go, and without it the withdrawal form cannot be
        // pre-filled from history and the history row cannot name the bank.
        bankName: true,
        status: true,
        paymentReference: true,
        // Shown when a request is rejected: the reason is already sent as a
        // notification, but a notification is missed and a row is not.
        adminNote: true,
        createdAt: true,
        processedAt: true,
      },
    });

    // Chat income: credited to the withdrawable balance the moment a message is
    // paid, so nothing is held. Its own service because the release job and this
    // card have to agree about what is held.
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
      // The withdrawal floor, and whether an admin has waived it for this
      // account. The dashboard renders the payout rule from these two, so the
      // screen and the payout service cannot disagree.
      minimumPayout: config.business.minPayoutAmount,
      payoutMinimumWaived: creatorFlags?.payoutMinimumWaived === true,
      // Withdrawals paused for this one account by an admin. `payoutFrozen` is
      // the decision; the date and the reason are what the creator is shown.
      payoutFrozen,
      payoutFrozenUntil: payoutFrozen
        ? creatorFlags?.payoutFrozenUntil?.toISOString() ?? null
        : null,
      payoutFrozenReason: payoutFrozen ? creatorFlags?.payoutFrozenReason ?? null : null,
      // Kept so the payload keeps one shape, but there is nothing held and
      // nothing left to clear: a sale is withdrawable the moment it settles.
      // Null/0 rather than a date, so an old client cannot render a release date
      // that will never arrive.
      nextReleaseAt: null,
      releasedThisWeek: 0,
      todayEarnings: todayTransactions._sum.creatorCut || 0,
      totalViews,
      videoStats: enrichedVideos,
      // Each row carries its own clear date and whether it is still held, so the
      // list answers "when does THIS payment unlock" without the client having
      // to know the holding length or re-derive the rule.
      // Each row reports when the money became withdrawable. There is no holding
      // period, so that is simply when the sale happened — the fields stay so the
      // dashboard keeps one shape, and they say the truth: nothing is held.
      recentTransactions: recentTransactions.map((tx) => ({
        ...tx,
        clearsAt: tx.createdAt.toISOString(),
        held: false,
      })),
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
