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
// Spending a balance, safely
//
// Every debit in this codebase goes through debitWallet below. Not for tidiness:
// the check and the write have to be ONE statement, and the only way to keep
// that true is to have one place where it happens.
//
// The bug this replaces: read the balance, compare it in JavaScript, then
// `decrement`. `decrement` is relative — it has no opinion about the result —
// and two spends that start together both read the old value and both pass.
// Measured on a 5,000 balance with five simultaneous purchases of 5,000, all
// five were accepted and the wallet finished at -20,000: the customer received
// TZS 25,000 of content for TZS 5,000, and nothing anywhere reported an error.
//
// Postgres decides instead. `UPDATE ... WHERE walletBalance >= amount` moves the
// row for exactly one caller; the losers get count 0, and that is what
// "insufficient funds" now means. The measured window is sub-millisecond against
// a local database, which is exactly why this survived: it opens up on a
// networked one.
// =============================================================================

export type WalletDebitResult =
  | { ok: true; balance: number }
  | { ok: false; balance: number };

/**
 * Take `amount` out of a wallet, atomically, refusing to overdraw.
 *
 * Must be called with the caller's transaction client so the debit and whatever
 * it paid for commit together: a debit that survives a failure to deliver is a
 * customer who paid for nothing.
 */
export async function debitWallet(
  tx: Prisma.TransactionClient,
  params: { userId: string; amount: number }
): Promise<WalletDebitResult> {
  const { userId, amount } = params;

  const debited = await tx.user.updateMany({
    where: { id: userId, walletBalance: { gte: amount } },
    data: { walletBalance: { decrement: amount } },
  });

  const after = await tx.user.findUnique({
    where: { id: userId },
    select: { walletBalance: true },
  });

  return { ok: debited.count === 1, balance: after?.walletBalance ?? 0 };
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
    // Conditional debit — see debitWallet. The pre-check that used to sit here
    // was a read, so five simultaneous purchases of one 5,000 balance all passed
    // it and all decremented. Nothing is decided in JavaScript any more.
    const debited = await debitWallet(tx, { userId, amount });

    if (!debited.ok) {
      return {
        success: false as const,
        reason: "INSUFFICIENT_FUNDS" as const,
        newBalance: debited.balance,
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
      newBalance: debited.balance,
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

