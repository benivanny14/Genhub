// =============================================================================
// GENHUB - Payment Webhook Processor
// Finalises every SonicPesa checkout (webhook, status poll or reconciliation)
// and applies the 70/30 creator/platform split.
// =============================================================================

import prisma from "../db";
import { creditCreatorAvailable, creditCreatorForPurchase, creditWallet, splitRevenue } from "./balance.service";
import { cacheDel } from "../redis";
import { assertSupportedSettlementProvider } from "../payments/gateway";
import { notifyPaymentResult } from "./payment-notify.service";
import { grantSubscription } from "./subscription.service";
import { consumeCoupon } from "../coupons";
import { releaseReferralBonus } from "./referral.service";
import { PAYMENT_EVENT, recordPaymentEvent } from "./payment-journey.service";
import { sendPushToUser } from "./push.service";

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

  // Runtime gateway lock: nothing but SonicPesa (or the dev sandbox marker) may
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
    await recordPaymentEvent({
      transactionId: orderId,
      kind: PAYMENT_EVENT.settledFailed,
      detail: `The gateway settled this charge as FAILED (${provider}).`,
      metadata: { provider },
    });
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

        // Credit the creator immediately — no holding period.
        await creditCreatorAvailable(tx, { creatorId: tipCreatorId, amount: tipCut });
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
      // The plan the customer paid for (weekly / monthly / quarterly). A
      // gateway-funded settlement must extend by the SAME period the checkout
      // charged, or a quarterly payment would silently grant one month.
      const plan =
        (transaction.metadata as { plan?: string } | null)?.plan ?? null;

      // The in-app notice is written inside the transaction; the push must wait
      // for it to commit. Hoisted so the send happens after the money and the
      // membership are durable, not while they are still provisional.
      let subscriptionPush: { userId: string; title: string; body: string } | null = null;

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
          plan,
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

        const noticeTitle = isRenewal ? "Membership renewed ⭐" : "New follower! ⭐";
        const noticeBody = `${isRenewal ? "A fan's" : "A viewer's"} subscription ${
          isRenewal ? "auto-renewed" : "is active"
        } — you earned TZS ${granted.creatorCut.toLocaleString("en-US")}.`;
        await tx.notification.create({
          data: {
            userId: creatorId,
            title: noticeTitle,
            message: noticeBody,
            type: "success",
            link: "/creator",
          },
        });
        subscriptionPush = { userId: creatorId, title: noticeTitle, body: noticeBody };
      });

      // Cast defeats the compiler's control-flow narrowing, which cannot see an
      // assignment made inside the transaction callback above.
      const pendingSubscriptionPush = subscriptionPush as {
        userId: string;
        title: string;
        body: string;
      } | null;
      if (pendingSubscriptionPush) {
        // Best-effort: the follower is already recorded and paid for, so a push
        // failure changes nothing the creator needs.
        void sendPushToUser(pendingSubscriptionPush.userId, {
          title: pendingSubscriptionPush.title,
          body: pendingSubscriptionPush.body,
          url: "/creator",
          tag: `subscription-${creatorId}`,
        });
      }
      break;
    }

    default:
      await prisma.transaction.update({
        where: { id: orderId },
        data: { status: "SUCCESS", providerRef: transactionId },
      });
  }

  // -------------------------------------------------------- The referral bonus
  //
  // Money has now landed for this customer, which is the whole condition for
  // paying whoever invited them: no sale, no bonus. It is released from HERE,
  // the single choke point every gateway payment passes through, rather than
  // from the purchase route — a bonus paid at checkout would be paid for USSD
  // prompts nobody approves, and the wallet and subscription paths would each
  // need their own copy of the rule.
  //
  // Called on every settled payment and pays at most once per invited account
  // (see services/referral.service.ts). It never throws: a bonus that could not
  // be paid must not undo a settlement that already happened.
  const referral = await releaseReferralBonus({ referredUserId: transaction.userId });
  if (referral.paid) {
    console.log(`[Webhook] Referral bonus released to ${referral.referrerId}`);
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

  await recordPaymentEvent({
    transactionId: orderId,
    kind: PAYMENT_EVENT.settledSuccess,
    detail: `Settled as SUCCESS — TZS ${amount.toLocaleString("en-US")} (${transaction.type}, via ${provider}).`,
    metadata: { provider, amount, type: transaction.type },
  });

  console.log(
    `[Webhook] Payment processed: ${orderId} | ${provider} | TZS ${amount} | ${transaction.type}`
  );

  return { processed: true };
}
