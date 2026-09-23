// =============================================================================
// GENHUB - Subscription service
// ONE implementation of "a subscription payment succeeded", shared by all three
// ways a membership is paid for:
//   * POST /api/subscriptions          (wallet path)
//   * processPaymentWebhook            (HarakaPay USSD settlement)
//   * subscription-renewal.service     (automatic renewal)
//
// Every caller runs grantSubscription() INSIDE a database transaction, so the
// money and the access can never diverge.
// =============================================================================

import type { Prisma } from "@prisma/client";
import prisma from "../db";
import config from "../config";

/** A membership period is one calendar month. */
export const SUBSCRIPTION_PERIOD_MONTHS = 1;

/**
 * When the next period ends.
 *
 * Extending from the current expiry (rather than from "now") means a fan who
 * renews early never loses the days they already paid for. If the membership
 * has already lapsed we start from today.
 */
export function nextRenewalDate(
  currentExpiry?: Date | null,
  months: number = SUBSCRIPTION_PERIOD_MONTHS
): Date {
  const now = new Date();
  const base =
    currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const next = new Date(base);
  next.setMonth(next.getMonth() + months);
  return next;
}

/** 30% platform / 70% creator, in whole TZS. */
export function splitSubscriptionAmount(amount: number): {
  platformFee: number;
  creatorCut: number;
} {
  const platformFee = Math.round(amount * (config.business.platformFeePercent / 100));
  return { platformFee, creatorCut: amount - platformFee };
}

export interface GrantSubscriptionParams {
  viewerId: string;
  creatorId: string;
  /** Amount actually collected (TZS). */
  amount: number;
  /** Phone the gateway charge went to — remembered for automatic renewals. */
  phone?: string | null;
  /** Total amount already applied to this period (fresh subscribe vs renewal). */
  isRenewal?: boolean;
}

export interface GrantSubscriptionResult {
  subscriptionId: string;
  expiresAt: Date;
  platformFee: number;
  creatorCut: number;
  /** True when an existing membership was extended rather than created. */
  extended: boolean;
}

/**
 * Activate or extend a membership, credit the creator's 70% into their 14-day
 * holding balance, and resync the creator's public subscriber counter.
 *
 * MUST be called with a `Prisma.TransactionClient` so it commits together with
 * the wallet debit / transaction row that funds it.
 */
export async function grantSubscription(
  tx: Prisma.TransactionClient,
  params: GrantSubscriptionParams
): Promise<GrantSubscriptionResult> {
  const { viewerId, creatorId, amount, phone, isRenewal } = params;
  const { platformFee, creatorCut } = splitSubscriptionAmount(amount);

  const existing = await tx.creatorSubscription.findUnique({
    where: { viewerId_creatorId: { viewerId, creatorId } },
    select: { id: true, expiresAt: true, isActive: true },
  });

  const now = new Date();
  const stillActive = !!existing && existing.isActive && existing.expiresAt > now;

  // Never lose paid-for days: extend an active membership from its expiry.
  const expiresAt = nextRenewalDate(stillActive ? existing!.expiresAt : null);

  const subscription = await tx.creatorSubscription.upsert({
    where: { viewerId_creatorId: { viewerId, creatorId } },
    create: {
      viewerId,
      creatorId,
      price: amount,
      expiresAt,
      isActive: true,
      autoRenew: true,
      lastRenewedAt: now,
      renewAttempts: 0,
      ...(phone ? { renewPhone: phone } : {}),
    },
    update: {
      price: amount,
      expiresAt,
      isActive: true,
      // A successful charge clears the renewal failure bookkeeping.
      renewAttempts: 0,
      lastRenewError: null,
      lastRenewedAt: now,
      ...(phone ? { renewPhone: phone } : {}),
    },
    select: { id: true },
  });

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

  // Resync the public counter from real active rows — it can never drift.
  const active = await tx.creatorSubscription.count({
    where: { creatorId, isActive: true, expiresAt: { gt: now } },
  });
  await tx.creatorProfile.upsert({
    where: { userId: creatorId },
    create: { userId: creatorId, totalSubscribers: active },
    update: { totalSubscribers: active },
  });

  return {
    subscriptionId: subscription.id,
    expiresAt,
    platformFee,
    creatorCut,
    extended: !!isRenewal || stillActive,
  };
}

/**
 * Resync ONE creator's public subscriber counter from the database.
 * Used after a membership lapses, and by the unsubscribe route.
 */
export async function resyncSubscriberCount(
  creatorId: string
): Promise<number> {
  const active = await prisma.creatorSubscription.count({
    where: { creatorId, isActive: true, expiresAt: { gt: new Date() } },
  });
  await prisma.creatorProfile.upsert({
    where: { userId: creatorId },
    create: { userId: creatorId, totalSubscribers: active },
    update: { totalSubscribers: active },
  });
  return active;
}
