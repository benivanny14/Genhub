// =============================================================================
// GENHUB - Wallet Top-Up API Route
// POST /api/payments/topup - Initiate wallet top-up via HarakaPay
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { topUpWalletSchema } from "@/lib/validation";
import {
  harakaCollect,
  harakaErrorReason,
  HarakaFloatEmptyError,
} from "@/lib/payments/harakapay";
import { assertSupportedGateway } from "@/lib/payments/gateway";
import { generateOrderId } from "@/lib/utils";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { applyCoupon } from "@/lib/coupons";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Same ceiling as a video purchase, and for the same reason: every call here
    // is a real USSD push to somebody's handset, so an unrestricted caller is
    // one script away from filling a phone with payment prompts — and the
    // purchase route has had this guard all along, which made the top-up route
    // the cheapest way to do it.
    const { allowed } = await checkRateLimit(
      `topup:${auth.userId}`,
      config.rateLimit.payment.max,
      config.rateLimit.payment.windowMs
    );
    if (!allowed) return api.rateLimited("Wait for the prompt before trying again");

    const body = await request.json();
    const result = topUpWalletSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    // HarakaPay is the only gateway — checkout is a USSD push to the phone.
    // Kept as a hard check on top of the Zod enum (see lib/payments/gateway).
    assertSupportedGateway(result.data.gateway);
    const { amount, phoneNumber, couponCode } = result.data;

    // Coupon bonus: extra wallet credit on top of the paid amount
    let bonus = 0;
    let couponId: string | undefined;
    if (couponCode) {
      const outcome = await applyCoupon({
        code: couponCode,
        amount,
        context: "topup",
        userId: auth.userId,
      });
      if (!outcome.valid) {
        return api.error(outcome.error || "This coupon is not valid", 400, "INVALID_COUPON");
      }
      bonus = outcome.bonus || 0;
      couponId = outcome.couponId;
    }

    // Create pending transaction (paid amount stays `amount`; bonus rides in metadata)
    const orderId = generateOrderId("WLT");
    const transaction = await prisma.transaction.create({
      data: {
        userId: auth.userId,
        amount,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "HARAKAPAY",
        metadata: couponId ? { couponId, bonus } : undefined,
      },
    });

    // Spent at settlement, not here: the bonus rides in metadata and the shared
    // payment webhook records the redemption when the money lands. Counting it at
    // checkout burned a limited coupon on every prompt nobody approved.

    // ------------------------------------------------------------ Sandbox mode
    const harakaSandbox =
      config.nodeEnv !== "production" &&
      (!config.harakaPay.apiKey || config.harakaPay.sandbox);

    if (harakaSandbox) {
      // Mirror production: HarakaPay-style order id so the webhook can find us
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
        amount,
        bonus,
      });
    }

    // Live USSD push — customer confirms on their phone
    const webhookUrl = `${config.appUrl}/api/webhooks/harakapay${
      config.harakaPay.webhookToken ? `?t=${config.harakaPay.webhookToken}` : ""
    }`;

    try {
      const response = await harakaCollect({
        phone: phoneNumber,
        amount,
        description: "Genhub - Wallet top-up",
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
        amount,
        bonus,
        message: response.message || "USSD push sent to phone",
      });
    } catch (harakaError: any) {
      const reason = harakaErrorReason(harakaError);
      // A refusal, not a failure. Nothing left this server and nothing was
      // charged, so the customer is told what happened and invited back —
      // instead of being shown a gateway error for a charge nobody attempted.
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
        return api.error(reason, harakaError.status, harakaError.code);
      }

      console.error("[HarakaPay TopUp Error]", reason, harakaError);
      return api.error(`Payment failed — HarakaPay: ${reason}`, 502, "GATEWAY_ERROR");
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[TopUp Error]", error);
    return api.internal();
  }
}
