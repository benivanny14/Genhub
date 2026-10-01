// =============================================================================
// GENHUB - Video Purchase API Route
// POST /api/payments/purchase - Initiate PPV payment via ClickPesa
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { initiatePaymentSchema } from "@/lib/validation";
import {
  clickpesaCollect,
  clickpesaErrorReason,
  clickpesaOrderReference,
  normalizeTzPhoneMsisdn,
} from "@/lib/payments/clickpesa";
import { purchaseVideoWithWallet } from "@/lib/services/balance.service";
import { notifyPaymentResult } from "@/lib/services/payment-notify.service";
import { resolvePendingCheckout } from "@/lib/services/checkout-lock.service";
import { assertSupportedGateway } from "@/lib/payments/gateway";
import { generateOrderId } from "@/lib/utils";
import config from "@/lib/config";
import { checkRateLimitStrict } from "@/lib/redis";
import { applyCoupon, consumeCoupon } from "@/lib/coupons";
import { videoStatus } from "@/lib/video-status";

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

    // Rate limit payment attempts. Money routes fail CLOSED on a shared-store
    // outage: a degraded limiter here is one that lets a script create charges
    // far faster than a person could, and the cost of that is real.
    const rl = await checkRateLimitStrict(
      `payment:${auth.userId}`,
      config.rateLimit.payment.max,
      config.rateLimit.payment.windowMs
    );
    if (rl.unavailable) {
      return api.error(
        "Payments are temporarily unavailable. Nothing was charged — please try again in a moment.",
        503,
        "TEMPORARILY_UNAVAILABLE"
      );
    }
    if (!rl.allowed) return api.rateLimited("Wait for the prompt before trying again");

    const body = await readJsonBody(request);
    const result = initiatePaymentSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    // ClickPesa is the only gateway — checkout is a USSD push to the phone.
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
        // Bunny's own numbers, to answer "can this be watched yet?" — see the
        // guard below.
        encodingStatus: true,
        encodeProgress: true,
      },
    });

    if (!video || !video.isPublished || video.isDeleted) {
      return api.notFound("Video not found");
    }

    // Can this scene be watched at all?
    //
    // A post is published the moment it is uploaded (see /api/videos POST), so
    // a video is deliberately visible — with its price on the card — while
    // Bunny is still transcoding it. It has no manifest yet: charging here
    // would take a customer's money, push a USSD prompt to their phone and
    // grant access to a scene that cannot play, then leave them arguing with a
    // spinner. Refused before any charge, any coupon and any transaction row,
    // exactly like the amount check below.
    //
    // FAILED is refused for the same reason from the other direction: the feed
    // hides those rows, but a bookmark, a shared link or a stale page still
    // reaches this route, and access to something that will never play is not
    // access.
    const status = videoStatus(video.encodingStatus, video.encodeProgress);
    if (status === "PROCESSING") {
      return api.error(
        "This scene is still being prepared for playback — it becomes available to buy in a few minutes. You have not been charged.",
        409,
        "VIDEO_PROCESSING"
      );
    }
    if (status === "FAILED") {
      return api.error(
        "This scene could not be prepared for playback, so it cannot be bought. You have not been charged.",
        409,
        "VIDEO_UNAVAILABLE"
      );
    }

    // Prevent buying own video
    if (video.creatorId === auth.userId) {
      return api.error("You cannot buy your own video", 400);
    }

    // Free videos never enter checkout — they unlock for everyone
    if (video.price === 0) {
      return api.error("This video is free — it unlocks without payment", 409, "FREE_VIDEO");
    }

    // The price is the video's, and only the video's. A client that sends an
    // amount is cross-checked against the row here, BEFORE anything is charged
    // and before any lock is taken: a mismatch refuses the payment outright
    // rather than quietly collecting the correct figure. Nothing is written, no
    // access is granted, and the message quotes the real price so the customer
    // is never left guessing which number was right. The amount itself is never
    // used as the charge — see `finalAmount = video.price` below.
    if (result.data.amount !== undefined && result.data.amount !== video.price) {
      return api.error(
        `This video costs TZS ${video.price.toLocaleString()}. The amount sent did not match, so you were not charged and the video stays locked.`,
        409,
        "AMOUNT_MISMATCH"
      );
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
      // One shared rule for when a checkout lock lifts (see
      // services/checkout-lock.service.ts): a fresh prompt keeps the lock, a stale
      // one is reconciled with the gateway and then released.
      const resolution = await resolvePendingCheckout(pendingTx);

      if (resolution.state === "fresh") {
        return api.error(
          `A payment for this video is still pending. Complete it on your phone, or try again in ${resolution.minutesLeft} minutes.`,
          409,
          "PENDING_PAYMENT"
        );
      }

      if (resolution.state === "paid") {
        return api.error(
          "Your payment already completed — refresh the page.",
          409,
          "ALREADY_PAID"
        );
      }
      // "released": the earlier prompt expired and the lock is gone — fall
      // through and start a fresh checkout.
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
    // ClickPesa takes an alphanumeric reference of at most 20 characters that WE
    // choose and it echoes back; it is stored as providerRef so the webhook and
    // the status poll can match the callback. Distinct from `orderId`, which is
    // our own database-friendly id.
    const providerRef = clickpesaOrderReference("PP");
    const transaction = await prisma.transaction.create({
      data: {
        userId: auth.userId,
        creatorId: video.creatorId,
        videoId,
        amount: finalAmount,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: "CLICKPESA",
        providerRef,
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
    const clickPesaSandbox =
      config.nodeEnv !== "production" &&
      (!config.clickPesa.apiKey || config.clickPesa.sandbox);

    if (clickPesaSandbox) {
      // Mirror production: a predictable reference so the dev completion route
      // can map the callback to this row.
      const sandboxRef = `cp_sbx_${transaction.id}`;
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { providerRef: sandboxRef },
      });
      return api.success({
        transactionId: transaction.id,
        orderId: sandboxRef,
        checkoutUrl: null,
        sandbox: true,
        gateway: "CLICKPESA",
        amount: finalAmount,
        originalAmount: video.price,
        discount: video.price - finalAmount,
      });
    }

    // Live USSD push — customer confirms on their phone. ClickPesa does not take
    // a webhook URL per request; the endpoint is configured in the dashboard, so
    // nothing is passed here.
    try {
      // Live mode with a non-public app URL means ClickPesa can never reach our
      // webhook; the /payments/status poll reconciles the payment instead. Log
      // it once so a stuck payment is diagnosable from the server log.
      if (/localhost|127\.0\.0\.1/i.test(config.appUrl)) {
        console.warn(
          "[ClickPesa] Live collect with a local app URL — webhooks cannot arrive; relying on status polling to reconcile."
        );
      }

      const response = await clickpesaCollect({
        phone: normalizeTzPhoneMsisdn(phoneNumber),
        amount: finalAmount,
        orderReference: providerRef,
      });

      if (!response.success || !response.orderReference) {
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED" },
        });
        return api.error(
          response.error || "ClickPesa rejected the payment request. Please try again.",
          502,
          "GATEWAY_REJECTED"
        );
      }

      // providerRef is already stored; echo the reference back to the client.
      return api.success({
        transactionId: transaction.id,
        orderId: response.orderReference,
        checkoutUrl: null,
        gateway: "CLICKPESA",
        status: "pending",
        amount: finalAmount,
        originalAmount: video.price,
        discount: video.price - finalAmount,
        message: response.message || "USSD push sent to phone",
      });
    } catch (gatewayError: any) {
      const reason = clickpesaErrorReason(gatewayError);
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", metadata: { gatewayError: reason } },
      });
      // The gateway's own words go to the log with a reference; the buyer gets a
      // sentence about their money and the reference. The old answer named the
      // gateway and repeated its reason, which told a customer nothing they could
      // act on and handed anyone watching the response a map of the payment path.
      return api.upstream(`collect failed for transaction ${transaction.id}: ${reason}`, {
        context: "Payments",
        status: 502,
        code: "GATEWAY_ERROR",
        message:
          "We could not start the payment just now. Nothing has been charged — please try again.",
      });
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Purchase Error]", error);
    return api.internal();
  }
}
