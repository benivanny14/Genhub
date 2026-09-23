// =============================================================================
// GENHUB - Creator Balance Service
// Manages the 70/30 revenue split, 14-day holding period, and payout logic
// =============================================================================

import prisma from "../db";
import config from "../config";
import { Prisma } from "@prisma/client";

const BUSINESS = config.business;

// =============================================================================
// Shared grant — the 70/30 split, creator balance, video earnings and access.
// Runs inside the caller's transaction so a gateway settlement and a wallet
// purchase apply exactly the same rules (they must never drift apart).
// =============================================================================

async function grantVideoPurchase(
  tx: Prisma.TransactionClient,
  params: {
    transactionId: string;
    viewerId: string;
    creatorId: string;
    videoId: string;
    totalAmount: number;
  }
): Promise<void> {
  const { transactionId, viewerId, creatorId, videoId, totalAmount } = params;
  const platformFee = Math.round(totalAmount * (BUSINESS.platformFeePercent / 100));
  const creatorCut = totalAmount - platformFee;

  // Update transaction with fee breakdown
  await tx.transaction.update({
    where: { id: transactionId },
    data: { platformFee, creatorCut, status: "SUCCESS" },
  });

  // Add to creator's pending balance (14-day holding)
  await tx.creatorBalance.upsert({
    where: { creatorId },
    create: {
      creatorId,
      pendingBalance: creatorCut,
      availableBalance: 0,
      totalEarned: creatorCut,
    },
    update: {
      pendingBalance: { increment: creatorCut },
      totalEarned: { increment: creatorCut },
    },
  });

  // Update video earnings
  await tx.videoEarning.upsert({
    where: { videoId },
    create: {
      videoId,
      totalEarned: creatorCut,
      totalPurchases: 1,
    },
    update: {
      totalEarned: { increment: creatorCut },
      totalPurchases: { increment: 1 },
    },
  });

  // Increment video purchase count
  await tx.video.update({
    where: { id: videoId },
    data: { purchaseCount: { increment: 1 } },
  });

  // Grant video access.
  //
  // Upsert, not create: a viewer can already own the video when a SECOND charge
  // for it settles — a stuck USSD charge landing after the customer paid from
  // their wallet, or a genuine double purchase. `create` threw P2002 there,
  // which rolled back the whole settlement (creator never credited) and made
  // every webhook retry fail forever, so money we had received was never
  // recorded. Access is a fact, not a counter: only the first one creates a row.
  await tx.videoAccess.upsert({
    where: { viewerId_videoId: { viewerId, videoId } },
    create: { viewerId, videoId },
    update: {},
  });
}

// =============================================================================
// Credit Creator After Successful Gateway Payment
// =============================================================================

export async function creditCreatorForPurchase(params: {
  transactionId: string;
  creatorId: string;
  videoId: string;
  totalAmount: number;
}): Promise<void> {
  const { transactionId, creatorId, videoId, totalAmount } = params;

  await prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { id: transactionId },
      select: { userId: true },
    });
    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);

    await grantVideoPurchase(tx, {
      transactionId,
      viewerId: transaction.userId,
      creatorId,
      videoId,
      totalAmount,
    });
  });
}

// =============================================================================
// Pay for a video from the wallet balance (instant, no gateway)
// Used when a HarakaPay charge fails and the customer prefers to spend the
// balance they already hold. Deduction, 70/30 split and access are ONE atomic
// transaction: either the customer is charged and unlocked, or nothing moves.
// =============================================================================

export type WalletPurchaseResult =
  | { success: true; transactionId: string; newBalance: number }
  | { success: false; reason: "INSUFFICIENT_FUNDS"; newBalance: number };

export async function purchaseVideoWithWallet(params: {
  userId: string;
  creatorId: string;
  videoId: string;
  amount: number;
  originalPrice: number;
  couponId?: string;
}): Promise<WalletPurchaseResult> {
  const { userId, creatorId, videoId, amount, originalPrice, couponId } = params;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { walletBalance: true },
    });

    if (!user || user.walletBalance < amount) {
      return {
        success: false as const,
        reason: "INSUFFICIENT_FUNDS" as const,
        newBalance: user?.walletBalance ?? 0,
      };
    }

    const created = await tx.transaction.create({
      data: {
        userId,
        creatorId,
        videoId,
        amount,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: null, // not a gateway charge
        metadata: couponId
          ? { method: "wallet", couponId, originalPrice, discount: originalPrice - amount }
          : { method: "wallet" },
      },
    });

    const updated = await tx.user.update({
      where: { id: userId },
      data: { walletBalance: { decrement: amount } },
      select: { walletBalance: true },
    });

    await grantVideoPurchase(tx, {
      transactionId: created.id,
      viewerId: userId,
      creatorId,
      videoId,
      totalAmount: amount,
    });

    return {
      success: true as const,
      transactionId: created.id,
      newBalance: updated.walletBalance,
    };
  });
}

// =============================================================================
// Credit Wallet from Top-Up
// =============================================================================

export async function creditWallet(
  userId: string,
  transactionId: string,
  amount: number
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: transactionId },
      data: { status: "SUCCESS" },
    });

    await tx.user.update({
      where: { id: userId },
      data: { walletBalance: { increment: amount } },
    });
  });
}

// =============================================================================
// 14-day holding release now lives in ONE place: earning-release.service.ts
// (releaseMatureEarnings, guarded by CreatorBalance.releasedTotal).
// A second implementation (processMaturedHoldings + HoldingPeriodLog) used
// to exist here — running both would have double-credited creators, so it
// was removed. /api/cron/process-holdings is a thin alias to the real one.
// =============================================================================

