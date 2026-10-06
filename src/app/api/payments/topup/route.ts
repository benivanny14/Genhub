// =============================================================================
// GENHUB - Wallet Top-Up API Route
// POST /api/payments/topup - Initiate wallet top-up via SonicPesa
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { topUpWalletSchema } from "@/lib/validation";
import {
  sonicpesaCollect,
  sonicpesaErrorReason,
  sonicpesaOrderReference,
  normalizeTzPhoneMsisdn,
} from "@/lib/payments/sonicpesa";
import { assertSupportedGateway } from "@/lib/payments/gateway";
import { generateOrderId } from "@/lib/utils";
import { checkRateLimitStrict } from "@/lib/redis";
import config from "@/lib/config";
import { applyCoupon } from "@/lib/coupons";
import { classifyGatewayFailure, gatewayFailureResponse } from "@/lib/gateway-failure";
import {
  PAYMENT_EVENT,
  recordPaymentEvent,
} from "@/lib/services/payment-journey.service";
import { getFeatureFlags } from "@/lib/services/platform-setting.service";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Operator kill switch: an admin can pause checkout while sorting a gateway
    // problem, and the customer is told the truth before any charge row exists.
    const flags = await getFeatureFlags();
    if (!flags.checkoutEnabled) {
      return api.error(
        "Top-ups are temporarily paused. Nothing was charged — please try again shortly.",
        503,
        "CHECKOUT_PAUSED"
      );
    }

    // Same ceiling as a video purchase, and for the same reason: every call here
    // is a real USSD push to somebody's handset, so an unrestricted caller is
    // one script away from filling a phone with payment prompts — and the
    // purchase route has had this guard all along, which made the top-up route
    // the cheapest way to do it.
    const rl = await checkRateLimitStrict(
      `topup:${auth.userId}`,
      config.rateLimit.payment.max,
      config.rateLimit.payment.windowMs
    );
    if (rl.unavailable) {
      return api.error(
        "Top-ups are temporarily unavailable. Nothing was charged — please try again in a moment.",
        503,
        "TEMPORARILY_UNAVAILABLE"
      );
    }
    if (!rl.allowed) return api.rateLimited("Wait for the prompt before trying again");

    const body = await readJsonBody(request);
    const result = topUpWalletSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    // SonicPesa is the only gateway — checkout is a USSD push to the phone.
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
    // Our own alphanumeric trace reference (kept in metadata for support).
    // SonicPesa assigns its own order id when create_order returns, and THAT is
    // stored as providerRef so the webhook and the status poll can match it.
    const providerRef = sonicpesaOrderReference("TP");
    const transaction = await prisma.transaction.create({
      data: {
        userId: auth.userId,
        amount,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "SONICPESA",
        providerRef,
        metadata: {
          ...(couponId ? { couponId, bonus } : {}),
          ourReference: providerRef,
        },
      },
    });

    await recordPaymentEvent({
      transactionId: transaction.id,
      kind: PAYMENT_EVENT.checkoutCreated,
      detail: `Top-up checkout created for TZS ${amount.toLocaleString("en-US")}${
        bonus > 0 ? ` (+${bonus.toLocaleString("en-US")} coupon bonus)` : ""
      }`,
      metadata: { providerRef, amount },
    });

    // Spent at settlement, not here: the bonus rides in metadata and the shared
    // payment webhook records the redemption when the money lands. Counting it at
    // checkout burned a limited coupon on every prompt nobody approved.

    // ------------------------------------------------------------ Sandbox mode
    const sonicPesaSandbox =
      config.nodeEnv !== "production" &&
      (!config.sonicPesa.accessKey || config.sonicPesa.sandbox);

    if (sonicPesaSandbox) {
      // Mirror production: a predictable reference so the dev completion route
      // can map the callback to this row.
      const sandboxRef = `sp_sbx_${transaction.id}`;
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { providerRef: sandboxRef },
      });
      return api.success({
        transactionId: transaction.id,
        orderId: sandboxRef,
        checkoutUrl: null,
        sandbox: true,
        gateway: "SONICPESA",
        amount,
        bonus,
      });
    }

    // Live USSD push — customer confirms on their phone. SonicPesa does not take
    // a webhook URL per request; the endpoint is configured in the dashboard.
    try {
      await recordPaymentEvent({
        transactionId: transaction.id,
        kind: PAYMENT_EVENT.collectStarted,
        detail: "USSD push requested from SonicPesa.",
        metadata: { providerRef },
      });

      const response = await sonicpesaCollect({
        phone: normalizeTzPhoneMsisdn(phoneNumber),
        amount,
        orderReference: providerRef,
        email: auth.email,
      });

      if (!response.success || !response.orderReference) {
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED" },
        });
        await recordPaymentEvent({
          transactionId: transaction.id,
          kind: PAYMENT_EVENT.collectRejected,
          detail: `SonicPesa refused the top-up: ${response.error || "no reason given"}`,
          metadata: { gatewayError: response.error ?? null },
        });
        // A refusal about OUR account (the daily API cap, unfinished KYC) is
        // answered with a plain sentence and logged — see lib/gateway-failure.ts.
        return gatewayFailureResponse({
          failure: classifyGatewayFailure(response.error),
          context: "Payments",
          transactionId: transaction.id,
        });
      }

      // The gateway assigned the order id; store it as providerRef — the key the
      // webhook and the status poll match on — and keep our trace reference in
      // metadata. Echo the gateway id back to the client.
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          providerRef: response.orderReference,
          metadata: {
            ...((transaction.metadata as Record<string, unknown> | null) ?? {}),
            gatewayOrderId: response.orderReference,
            gatewayReference: response.transactionId ?? null,
          },
        },
      });

      return api.success({
        transactionId: transaction.id,
        orderId: response.orderReference,
        checkoutUrl: null,
        gateway: "SONICPESA",
        status: "pending",
        amount,
        bonus,
        message: response.message || "USSD push sent to phone",
      });
    } catch (gatewayError: any) {
      const reason = sonicpesaErrorReason(gatewayError);
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", metadata: { gatewayError: reason } },
      });
      await recordPaymentEvent({
        transactionId: transaction.id,
        kind: PAYMENT_EVENT.collectFailed,
        detail: `Could not reach SonicPesa: ${reason}`,
        metadata: { gatewayError: reason },
      });
      // Detail to the log, a plain sentence to the user — see api.upstream.
      return api.upstream(`top-up collect failed for transaction ${transaction.id}: ${reason}`, {
        context: "Payments",
        status: 502,
        code: "GATEWAY_ERROR",
        message:
          "We could not start the top-up just now. Nothing has been charged — please try again.",
      });
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[TopUp Error]", error);
    return api.internal();
  }
}
