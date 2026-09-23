// =============================================================================
// GENHUB - Creator Subscriptions API Route
// POST /api/subscriptions - Subscribe to a creator
// GET /api/subscriptions - List subscriptions
// DELETE /api/subscriptions - Unsubscribe
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { z } from "zod";
import config from "@/lib/config";
import { harakaCollect, harakaErrorReason } from "@/lib/payments/harakapay";
import { generateOrderId } from "@/lib/utils";
import { checkRateLimit } from "@/lib/redis";
import { grantSubscription, resyncSubscriberCount } from "@/lib/services/subscription.service";
import { debitWallet } from "@/lib/services/balance.service";

const subscribeSchema = z.object({
  creatorId: z.string().min(1),
  // Optional: when present the subscription is paid by USSD push (HarakaPay)
  // exactly like a video purchase; when absent the legacy wallet path runs.
  phoneNumber: z.string().regex(/^(\+255|0)[67]\d{8}$/).optional(),
});

const autoRenewSchema = z.object({
  creatorId: z.string().min(1),
  autoRenew: z.boolean(),
});

// POST /api/subscriptions - Subscribe
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json();
    const result = subscribeSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { creatorId } = result.data;

    if (creatorId === auth.userId) return api.error("You cannot subscribe to yourself");

    // Get creator and their subscription price
    const creator = await prisma.user.findUnique({
      where: { id: creatorId, role: "CREATOR" },
      include: { creatorProfile: true },
    });
    if (!creator || creator.isBanned) return api.notFound("This creator does not exist");

    const price = creator.creatorProfile?.subscriptionPrice || 5000;

    // Check existing subscription
    const existing = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: auth.userId, creatorId } },
    });

    if (existing && existing.isActive && existing.expiresAt > new Date()) {
      return api.error("You already follow this creator");
    }

    // ------------------------------------------------- Pay by phone (USSD push)
    // Same flow as video purchases: create a PENDING SUBSCRIPTION transaction,
    // push USSD to the viewer's phone, and let the webhook/status poll activate
    // the plan (processPaymentWebhook → SUBSCRIPTION case).
    if ("phoneNumber" in body && body.phoneNumber) {
      const { allowed } = await checkRateLimit(
        `payment:${auth.userId}`,
        config.rateLimit.payment.max,
        config.rateLimit.payment.windowMs
      );
      if (!allowed) return api.rateLimited("Wait for the prompt before trying again");

      // One live checkout per viewer+creator — otherwise two PENDING rows could
      // both be fulfilled later.
      const pendingTx = await prisma.transaction.findFirst({
        where: {
          userId: auth.userId,
          creatorId,
          type: "SUBSCRIPTION",
          status: "PENDING",
        },
        select: { id: true },
      });
      if (pendingTx) {
        return api.error(
          "A payment for this subscription is still pending. Earlier attempts were cancelled.",
          409,
          "PENDING_PAYMENT"
        );
      }

      const orderId = generateOrderId("SUB");
      const transaction = await prisma.transaction.create({
        data: {
          userId: auth.userId,
          creatorId,
          amount: price,
          type: "SUBSCRIPTION",
          status: "PENDING",
          gateway: "HARAKAPAY",
          metadata: { orderId, plan: "monthly", phone: body.phoneNumber },
        },
      });

      // Mirror production in local dev: store a HarakaPay-style order id so the
      // real webhook and the status poll can map callbacks to this row.
      const harakaSandbox =
        config.nodeEnv !== "production" &&
        (!config.harakaPay.apiKey || config.harakaPay.sandbox);

      if (harakaSandbox) {
        const sandboxRef = `hp_sbx_${transaction.id}`;
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { providerRef: sandboxRef },
        });
        return api.success({
          transactionId: transaction.id,
          orderId: sandboxRef,
          checkoutUrl: null,
          sandbox: true,
          gateway: "HARAKAPAY",
          amount: price,
        });
      }

      const webhookUrl = `${config.appUrl}/api/webhooks/harakapay${
        config.harakaPay.webhookToken ? `?t=${config.harakaPay.webhookToken}` : ""
      }`;

      try {
        const response = await harakaCollect({
          phone: body.phoneNumber,
          amount: price,
          description: `Genhub subscription - ${creator.displayName || "creator"}`,
          webhookUrl,
        });

        if (!response.success || !response.order_id) {
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: { status: "FAILED" },
          });
          return api.error(
            response.error || "HarakaPay rejected the payment request. Please try again.",
            502,
            "GATEWAY_REJECTED"
          );
        }

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { providerRef: response.order_id },
        });

        return api.success({
          transactionId: transaction.id,
          orderId: response.order_id,
          checkoutUrl: null,
          gateway: "HARAKAPAY",
          status: "pending",
          amount: price,
          message: response.message || "USSD push sent to phone",
        });
      } catch (harakaError: any) {
        const reason = harakaErrorReason(harakaError);
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED", metadata: { gatewayError: reason } },
        });
        console.error("[HarakaPay Subscribe Error]", reason, harakaError);
        return api.error(`Payment failed — HarakaPay: ${reason}`, 502, "GATEWAY_ERROR");
      }
    }

    // ------------------------------------------------- Legacy wallet path
    // Read only for the notification's display name — the balance is NOT checked
    // here. A read cannot authorise a debit: it describes the moment before it,
    // which is how two checkouts starting together both passed.
    const viewer = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { displayName: true },
    });

    // Create subscription — 30% platform, 70% creator. Steps 1-3 (debit, split,
    // access) are one transaction via the shared grantSubscription(), so a
    // wallet subscribe, a gateway settlement and an auto-renewal can never
    // disagree about the price, the split or the expiry date.
    const subscription = await prisma.$transaction(async (tx) => {
      // The debit is the check (debitWallet): it refuses rather than overdrawing
      // when someone spent the balance first — a video purchase, a tip, or the
      // renewal worker charging a due membership at the same instant.
      const debited = await debitWallet(tx, { userId: auth.userId, amount: price });
      if (!debited.ok) return null;

      await tx.transaction.create({
        data: {
          userId: auth.userId,
          creatorId,
          amount: price,
          type: "SUBSCRIPTION",
          status: "SUCCESS",
          gateway: null, // paid from the wallet, not a gateway charge
          metadata: { method: "wallet" },
          platformFee: Math.round(price * (config.business.platformFeePercent / 100)),
          creatorCut: price - Math.round(price * (config.business.platformFeePercent / 100)),
        },
      });

      await tx.notification.create({
        data: {
          userId: creatorId,
          title: "New follower! ⭐",
          message: `${viewer?.displayName || "A viewer"} subscribed to your profile`,
          type: "success",
          link: "/creator",
        },
      });

      return grantSubscription(tx, {
        viewerId: auth.userId,
        creatorId,
        amount: price,
      });
    });

    if (!subscription) {
      return api.error(
        `Your balance is too low. You need TZS ${price.toLocaleString()}. Top up your wallet to subscribe.`
      );
    }

    return api.success(subscription, "Umejiandikisha kikamilifu!", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Subscribe Error]", error);
    return api.internal();
  }
}

// GET /api/subscriptions?creatorId=xxx or mine
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();
    const creatorId = request.nextUrl.searchParams.get("creatorId");

    if (creatorId) {
      // Check if subscribed to specific creator
      const sub = await prisma.creatorSubscription.findUnique({
        where: { viewerId_creatorId: { viewerId: auth.userId, creatorId } },
        select: { isActive: true, expiresAt: true, price: true },
      });

      const isActive = sub?.isActive && sub.expiresAt > new Date();
      return api.success({ subscribed: isActive, subscription: sub });
    }

    // List all subscriptions
    const subs = await prisma.creatorSubscription.findMany({
      where: { viewerId: auth.userId, isActive: true, expiresAt: { gt: new Date() } },
      include: {
        creator: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return api.success(subs);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[List Subscriptions Error]", error);
    return api.internal();
  }
}

// PATCH /api/subscriptions { creatorId, autoRenew } - turn automatic renewal
// on/off for one membership. Turning it off keeps access until expiresAt; the
// renewal cron skips memberships with autoRenew = false.
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const parsed = autoRenewSchema.safeParse(body);
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);
    const { creatorId, autoRenew } = parsed.data;

    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: auth.userId, creatorId } },
    });
    if (!sub) return api.notFound("You are not subscribed to this creator");

    const updated = await prisma.creatorSubscription.update({
      where: { id: sub.id },
      data: {
        autoRenew,
        // Re-enabling clears the old failure bookkeeping so the cron tries
        // again immediately instead of waiting for the retry gap.
        ...(autoRenew
          ? { renewAttempts: 0, lastRenewError: null, lastRenewAttemptAt: null }
          : {}),
      },
      select: { autoRenew: true, expiresAt: true, price: true },
    });

    return api.success(
      updated,
      autoRenew
        ? "Automatic renewal is on — we will charge your wallet, or send a USSD prompt, before it expires."
        : "Automatic renewal is off — access continues until the period ends."
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Update Subscription Error]", error);
    return api.internal();
  }
}

// DELETE /api/subscriptions { creatorId } - unsubscribe. The row is kept for
// history (isActive=false) and the creator's public counter is resynced from
// the database so it can never drift. No refund — the period was already paid.
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const result = subscribeSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);
    const { creatorId } = result.data;

    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: auth.userId, creatorId } },
    });
    if (!sub || !sub.isActive) {
      return api.error("You are not subscribed to this creator", 404, "NOT_SUBSCRIBED");
    }

    await prisma.creatorSubscription.update({
      where: { id: sub.id },
      // autoRenew off as well, so the renewal cron stops charging for a
      // membership the fan has explicitly ended.
      data: { isActive: false, autoRenew: false },
    });

    await resyncSubscriberCount(creatorId);

    return api.success(null, "You have unfollowed this creator");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Unsubscribe Error]", error);
    return api.internal();
  }
}
