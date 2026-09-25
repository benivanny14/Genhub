// =============================================================================
// GENHUB - Video Purchase API Route
// POST /api/payments/purchase - Initiate PPV payment via HarakaPay
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { initiatePaymentSchema } from "@/lib/validation";
import {
  harakaCollect,
  harakaErrorReason,
  harakaStatus,
  harakaStatusToInternal,
  HarakaFloatEmptyError,
} from "@/lib/payments/harakapay";
import { processPaymentWebhook } from "@/lib/services/webhook.service";
import { purchaseVideoWithWallet } from "@/lib/services/balance.service";
import { notifyPaymentResult } from "@/lib/services/payment-notify.service";
import { assertSupportedGateway } from "@/lib/payments/gateway";
import { generateOrderId } from "@/lib/utils";
import config from "@/lib/config";
import { checkRateLimit } from "@/lib/redis";
import { applyCoupon, consumeCoupon } from "@/lib/coupons";

// How long an unpaid checkout keeps the video locked for that customer. A USSD
// prompt is usually answered in a minute or two; after this window we reconcile
// with the gateway, then release the lock so they can try again.
const PENDING_PAYMENT_TTL_MS = 10 * 60 * 1000;

/**
 * The smallest amount the gateway will collect.
 *
 * A coupon that covers the whole price produces a TZS 0 checkout, and a collect
 * for 0 is not a free sale — it is a request the gateway rejects, after the
 * customer has been told a prompt is coming. A 100% coupon is therefore refused
 * with the reason, rather than turning into a checkout that cannot succeed.
 */
const MIN_GATEWAY_AMOUNT_TZS = 100;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Rate limit payment attempts
    const { allowed } = await checkRateLimit(
      `payment:${auth.userId}`,
      config.rateLimit.payment.max,
      config.rateLimit.payment.windowMs
    );
    if (!allowed) return api.rateLimited("Wait for the prompt before trying again");

    const body = await request.json();
    const result = initiatePaymentSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    // HarakaPay is the only gateway — checkout is a USSD push to the phone.
    // The assertion is belt-and-braces on top of the Zod enum: if anything ever
    // routes here with another gateway it fails loudly instead of silently.
    assertSupportedGateway(result.data.gateway);
    const { videoId, method, phoneNumber, couponCode } = result.data;

    // Find video and verify it exists
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        title: true,
        price: true,
        creatorId: true,
        isPublished: true,
        isDeleted: true,
      },
    });

    if (!video || !video.isPublished || video.isDeleted) {
      return api.notFound("Video not found");
    }

    // Prevent buying own video
    if (video.creatorId === auth.userId) {
      return api.error("You cannot buy your own video", 400);
    }

    // Free videos never enter checkout — they unlock for everyone
    if (video.price === 0) {
      return api.error("This video is free — it unlocks without payment", 409, "FREE_VIDEO");
    }

    // Check if already purchased
    const existingAccess = await prisma.videoAccess.findUnique({
      where: {
        viewerId_videoId: {
          viewerId: auth.userId,
          videoId,
        },
      },
    });

    if (existingAccess) {
      return api.error("You already own this video", 409);
    }

    // Block a second checkout while one is still awaiting payment — otherwise
    // two PENDING rows for the same user+video could both be fulfilled later.
    const pendingTx = await prisma.transaction.findFirst({
      where: {
        userId: auth.userId,
        videoId,
        type: "PPV_PURCHASE",
        status: "PENDING",
      },
      select: { id: true, createdAt: true, providerRef: true, amount: true },
    });

    if (pendingTx) {
      const ageMs = Date.now() - pendingTx.createdAt.getTime();

      if (ageMs < PENDING_PAYMENT_TTL_MS) {
        const minutesLeft = Math.ceil(
          (PENDING_PAYMENT_TTL_MS - ageMs) / 60_000
        );
        return api.error(
          `A payment for this video is still pending. Complete it on your phone, or try again in ${minutesLeft} minutes.`,
          409,
          "PENDING_PAYMENT"
        );
      }

      // The attempt is stale: usually a USSD prompt the customer never approved.
      // Ask the gateway before releasing the lock, because the money may have
      // moved while the webhook was lost.
      let alreadyPaid = false;
      if (
        pendingTx.providerRef &&
        config.harakaPay.apiKey &&
        !config.harakaPay.sandbox
      ) {
        try {
          const remote = await harakaStatus(pendingTx.providerRef);
          const internal = remote.payment
            ? harakaStatusToInternal(remote.payment.status)
            : null;

          if (internal) {
            // Finalises the row either way (SUCCESS grants access, FAILED clears it)
            await processPaymentWebhook({
              orderId: pendingTx.id,
              transactionId: pendingTx.providerRef,
              amount: pendingTx.amount,
              status: internal,
              provider: "HARAKAPAY",
              metadata: { reconciled: "stale-pending" },
            });
            alreadyPaid = internal === "SUCCESS";
          }
        } catch (reconcileError: any) {
          console.warn(
            "[Purchase] Stale-pending reconcile failed:",
            reconcileError?.message || reconcileError
          );
        }
      }

      if (alreadyPaid) {
        return api.error(
          "Your payment already completed — refresh the page.",
          409,
          "ALREADY_PAID"
        );
      }

      // Release the lock so the customer can pay again, and tell them the
      // earlier prompt expired rather than letting it fail silently.
      await prisma.transaction.update({
        where: { id: pendingTx.id },
        data: { status: "FAILED", metadata: { expired: true } },
      });
      await notifyPaymentResult({
        transactionId: pendingTx.id,
        outcome: "FAILED",
        reason: "expired",
      });
    }

    // Apply coupon discount (if any)
    let finalAmount = video.price;
    let couponId: string | undefined;
    if (couponCode) {
      const outcome = await applyCoupon({
        code: couponCode,
        amount: video.price,
        context: "purchase",
      });
      if (!outcome.valid) {
        return api.error(outcome.error || "This coupon is not valid", 400, "INVALID_COUPON");
      }
      finalAmount = outcome.finalAmount ?? video.price;
      couponId = outcome.couponId;

      if (method === "PHONE" && finalAmount < MIN_GATEWAY_AMOUNT_TZS) {
        return api.error(
          `This coupon covers the whole price, and the mobile-money gateway cannot collect ` +
            `less than TZS ${MIN_GATEWAY_AMOUNT_TZS}. Pay from your wallet instead, or use the ` +
            `coupon on a different video.`,
          400,
          "COUPON_COVERS_TOTAL"
        );
      }
    }

    // ----------------------------------------------------------------- Wallet
    // Fallback for a failed phone charge (or a customer who prefers it): spend
    // the wallet balance instead. Charge, 70/30 split and access are one atomic
    // transaction, so the customer can never be charged without being unlocked.
    if (method === "WALLET") {
      const outcome = await purchaseVideoWithWallet({
        userId: auth.userId,
        creatorId: video.creatorId,
        videoId,
        amount: finalAmount,
        originalPrice: video.price,
        couponId,
      });

      if (!outcome.success) {
        return api.error(
          `Your wallet balance is too low. You need TZS ${finalAmount.toLocaleString()} and you have TZS ${outcome.newBalance.toLocaleString()}.`,
          402,
          "INSUFFICIENT_WALLET"
        );
      }

      // Count the coupon only now that money actually moved, and atomically —
      // this is a settlement path, not a checkout.
      if (couponId) {
        const consumed = await consumeCoupon({
          couponId,
          userId: auth.userId,
          transactionId: outcome.transactionId,
        });
        if (consumed !== "OK") {
          // The customer paid the discounted price either way; a coupon that ran
          // out in the meantime is our over-issue to absorb, not theirs.
          console.warn(
            `[Coupon] ${consumed} after a wallet purchase (user=${auth.userId}, coupon=${couponId}) — the sale stands`
          );
        }
      }

      await notifyPaymentResult({
        transactionId: outcome.transactionId,
        outcome: "SUCCESS",
      });

      return api.success({
        transactionId: outcome.transactionId,
        orderId: outcome.transactionId,
        checkoutUrl: null,
        gateway: null,
        method: "WALLET",
        status: "success",
        amount: finalAmount,
        originalPrice: video.price,
        discount: video.price - finalAmount,
        newBalance: outcome.newBalance,
        message: "Paid from your wallet balance — the video is now unlocked",
      });
    }

    if (!phoneNumber) {
      return api.validation("A phone number is required for mobile money payments");
    }

    // Create pending transaction
    const orderId = generateOrderId("PPV");
    const transaction = await prisma.transaction.create({
      data: {
        userId: auth.userId,
        creatorId: video.creatorId,
        videoId,
        amount: finalAmount,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: "HARAKAPAY",
        metadata: couponId
          ? { couponId, originalPrice: video.price, discount: video.price - finalAmount }
          : undefined,
      },
    });

    // The coupon is recorded in the transaction metadata and spent later, at
    // settlement — see lib/coupons.ts. Counting it here is what burned a limited
    // coupon for every customer who never approved the USSD prompt.

    // ------------------------------------------------------------- Sandbox mode
    // PAYMENT_SANDBOX=true in local dev skips the real USSD push; the client
    // completes via POST /api/dev/sandbox/complete, which runs the exact same
    // webhook processing as production.
    const harakaSandbox =
      config.nodeEnv !== "production" &&
      (!config.harakaPay.apiKey || config.harakaPay.sandbox);

    if (harakaSandbox) {
      // Mirror production: store a HarakaPay-style order id so the real
      // webhook (/api/webhooks/harakapay) can map callbacks to this row.
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
        amount: finalAmount,
        originalAmount: video.price,
        discount: video.price - finalAmount,
      });
    }

    // Live USSD push — customer confirms on their phone
    const webhookUrl = `${config.appUrl}/api/webhooks/harakapay${
      config.harakaPay.webhookToken ? `?t=${config.harakaPay.webhookToken}` : ""
    }`;

    try {
      // Live mode with a non-public app URL means HarakaPay can never reach
      // our webhook; the /payments/status poll reconciles the payment instead.
      // Log it once so a stuck payment is diagnosable from the server log.
      if (/localhost|127\.0\.0\.1/i.test(config.appUrl)) {
        console.warn(
          "[HarakaPay] Live collect with a local app URL — webhooks cannot arrive; relying on status polling to reconcile."
        );
      }

      const response = await harakaCollect({
        phone: phoneNumber,
        amount: finalAmount,
        description: `Genhub - ${video.title}`,
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

      // Track HarakaPay's order_id so the webhook/status poll can find us
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
        amount: finalAmount,
        originalAmount: video.price,
        discount: video.price - finalAmount,
        message: response.message || "USSD push sent to phone",
      });
    } catch (harakaError: any) {
      const reason = harakaErrorReason(harakaError);
      // Refused before anything was sent, because the merchant float is empty
      // and the prompt would never arrive. The customer is owed the reason and
      // the fact that they were not charged — and the WALLET path above still
      // works, so this is a redirect, not a dead end.
      const floatEmpty = harakaError instanceof HarakaFloatEmptyError;

      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: "FAILED",
          metadata: floatEmpty
            ? { refusal: "FLOAT_EMPTY", gatewayError: reason }
            : { gatewayError: reason },
        },
      });

      if (floatEmpty) {
        // The wallet fallback is real and unaffected (the float is only needed to
        // push a prompt to a handset), and this screen offers it — so the refusal
        // names it, instead of leaving the customer to find it.
        return api.error(
          `${reason} You can pay from your wallet balance instead.`,
          harakaError.status,
          harakaError.code
        );
      }

      console.error("[HarakaPay Collect Error]", reason, harakaError);
      return api.error(`Payment failed — HarakaPay: ${reason}`, 502, "GATEWAY_ERROR");
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Purchase Error]", error);
    return api.internal();
  }
}
