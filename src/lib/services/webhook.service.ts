// =============================================================================
// GENHUB - Payment Webhook Processor
// Finalises every HarakaPay checkout (webhook, status poll or reconciliation)
// and applies the 70/30 creator/platform split.
// =============================================================================

import prisma from "../db";
import { creditCreatorForPurchase, creditWallet, splitRevenue } from "./balance.service";
import { cacheDel } from "../redis";
import { assertSupportedSettlementProvider } from "../payments/gateway";
import { notifyPaymentResult } from "./payment-notify.service";
import { grantSubscription } from "./subscription.service";
import { consumeCoupon } from "../coupons";

// =============================================================================
// Process Successful Payment Webhook
// =============================================================================

export async function processPaymentWebhook(params: {
  orderId: string;
  transactionId: string;
  amount: number;
  status: "SUCCESS" | "FAILED";
  provider: string;
  metadata?: Record<string, unknown>;
}): Promise<{ processed: boolean; reason?: string }> {
  const { orderId, transactionId, amount, status, provider } = params;

  // Runtime gateway lock: nothing but HarakaPay (or the dev sandbox marker) may
  // settle money. This is the single choke point every payment flows through.
  assertSupportedSettlementProvider(provider);

  // Find the pending transaction in our database
  let transaction = await prisma.transaction.findFirst({
    where: {
      id: orderId,
      status: "PENDING",
    },
  });

  if (!transaction) {
    // Two non-PENDING states are still settleable, and settling them is what
    // keeps real money from being lost:
    //   * FAILED with metadata.expired — a checkout soft-expired so the customer
    //     could try again (see /api/payments/purchase). If the payer approved the
    //     prompt late, the gateway still tells us.
    //   * UNDER_INVESTIGATION — the gateway accepted the charge and never
    //     settled it, so we could neither confirm nor deny it. This callback IS
    //     the confirmation.
    // Anything else really has been processed already.
    const reopenable = await prisma.transaction.findFirst({
      where: { id: orderId, status: { in: ["FAILED", "UNDER_INVESTIGATION"] } },
    });
    const meta = (reopenable?.metadata ?? {}) as { expired?: boolean };
    const settledLate =
      !!reopenable &&
      (reopenable.status === "UNDER_INVESTIGATION" || meta.expired === true);

    if (!settledLate) {
      console.warn(`Webhook for unknown/processed order: ${orderId}`);
      return { processed: false, reason: "Order not found or already processed" };
    }

    console.log(
      `[Webhook] Late settlement for ${reopenable!.status} order: ${orderId}`
    );
    transaction = reopenable!;
  }

  if (status === "FAILED") {
    await prisma.transaction.update({
      where: { id: orderId },
      data: { status: "FAILED", providerRef: transactionId },
    });
    // Tell the customer (in-app + email) so a failed charge never goes silent.
    await notifyPaymentResult({ transactionId: orderId, outcome: "FAILED" });
    return { processed: true, reason: "Payment failed" };
  }

  // Status is SUCCESS - process based on transaction type.
  //
  // Clear the investigation flag first: a charge can be resolved by a settlement
  // arriving after it was flagged (the gateway finally confirming the money),
  // and leaving `investigation: true` on a SUCCESS row makes the admin queue and
  // the audit trail lie about the state of the order.
  if ((transaction.metadata as { investigation?: boolean } | null)?.investigation) {
    await prisma.transaction.update({
      where: { id: orderId },
      data: {
        metadata: {
          ...(transaction.metadata as Record<string, unknown>),
          investigation: false,
          settledLate: true,
          settledAt: new Date().toISOString(),
        },
      },
    });
  }

  switch (transaction.type) {
    case "PPV_PURCHASE":
      if (transaction.creatorId && transaction.videoId) {
        await creditCreatorForPurchase({
          transactionId: transaction.id,
          creatorId: transaction.creatorId,
          videoId: transaction.videoId,
          totalAmount: amount,
        });
      }
      break;

    case "WALLET_TOPUP": {
      // Include any coupon bonus recorded when the top-up was initiated
      const meta = (transaction.metadata || {}) as { bonus?: number };
      const bonus = typeof meta.bonus === "number" && meta.bonus > 0 ? meta.bonus : 0;
      await creditWallet(transaction.userId, transaction.id, amount + bonus);
      break;
    }

    case "TIP": {
      // A tip that settles through the gateway, not the wallet path in
      // /api/tips. No route creates one today, but if one ever does it has to
      // split like everything else — paying 100% here would be the only place in
      // the codebase that does.
      if (!transaction.creatorId) break;
      const tipCreatorId = transaction.creatorId;
      const { platformFee: tipFee, creatorCut: tipCut } = splitRevenue(amount);

      await prisma.$transaction(async (tx) => {
        await tx.transaction.update({
          where: { id: orderId },
          data: {
            status: "SUCCESS",
            providerRef: transactionId,
            platformFee: tipFee,
            creatorCut: tipCut,
          },
        });

        await tx.creatorBalance.upsert({
          where: { creatorId: tipCreatorId },
          create: {
            creatorId: tipCreatorId,
            pendingBalance: tipCut,
            availableBalance: 0,
            totalEarned: tipCut,
          },
          update: {
            pendingBalance: { increment: tipCut },
            totalEarned: { increment: tipCut },
          },
        });
      });
      break;
    }

    case "SUBSCRIPTION": {
      // Gateway-funded subscription (first subscribe OR an automatic renewal):
      // activate/extend the plan AND credit the creator — without this branch
      // the money moved but the viewer never actually became a subscriber.
      if (!transaction.creatorId) break;
      const creatorId = transaction.creatorId;
      const isRenewal = Boolean(
        (transaction.metadata as { renewal?: boolean } | null)?.renewal
      );
      const phone =
        (transaction.metadata as { phone?: string } | null)?.phone ?? null;

      await prisma.$transaction(async (tx) => {
        // One shared implementation of "a subscription payment succeeded" is
        // used by the wallet path, this webhook and the renewal cron, so the
        // split and the expiry maths can never diverge between them.
        const granted = await grantSubscription(tx, {
          viewerId: transaction.userId,
          creatorId,
          amount,
          phone,
          isRenewal,
        });

        await tx.transaction.update({
          where: { id: orderId },
          data: {
            status: "SUCCESS",
            providerRef: transactionId,
            platformFee: granted.platformFee,
            creatorCut: granted.creatorCut,
          },
        });

        await tx.notification.create({
          data: {
            userId: creatorId,
            title: isRenewal ? "Membership renewed ⭐" : "New follower! ⭐",
            message: `${isRenewal ? "A fan's" : "A viewer's"} subscription ${
              isRenewal ? "auto-renewed" : "is active"
            } — you earned TZS ${granted.creatorCut.toLocaleString("en-US")}.`,
            type: "success",
            link: "/creator",
          },
        });
      });
      break;
    }

    default:
      await prisma.transaction.update({
        where: { id: orderId },
        data: { status: "SUCCESS", providerRef: transactionId },
      });
  }

  // --------------------------------------------------------------- The coupon
  //
  // Spent here, where the money lands, and not at checkout — a checkout counts
  // a coupon the moment a USSD prompt is requested, and the common outcome of
  // that prompt is that nobody approves it. Counting it there burned a limited
  // coupon for a sale that never happened.
  //
  // One call for every settled type, because the coupon rides in the metadata:
  // this is the single choke point a payment passes through, so a future type
  // cannot quietly skip it. `consumeCoupon` never throws, and a refusal is
  // logged rather than raised: the customer has already paid the discounted
  // price, so a coupon that ran out in the meantime is ours to absorb, not
  // theirs to be told about after the fact.
  const couponId = (transaction.metadata as { couponId?: unknown } | null)?.couponId;
  if (typeof couponId === "string" && couponId) {
    const consumed = await consumeCoupon({
      couponId,
      userId: transaction.userId,
      transactionId: transaction.id,
    });
    if (consumed !== "OK") {
      console.warn(
        `[Webhook] Coupon ${consumed} at settlement (order=${orderId}, coupon=${couponId}) — the sale stands`
      );
    }
  }

  // Invalidate relevant caches
  await cacheDel(`video:*`);
  await cacheDel(`user:${transaction.userId}:*`);

  // Tell the customer the charge is done (in-app + email when we have one).
  await notifyPaymentResult({ transactionId: orderId, outcome: "SUCCESS" });

  console.log(
    `[Webhook] Payment processed: ${orderId} | ${provider} | TZS ${amount} | ${transaction.type}`
  );

  return { processed: true };
}
