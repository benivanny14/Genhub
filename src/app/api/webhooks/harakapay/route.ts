// =============================================================================
// GENHUB - HarakaPay Webhook Handler
// POST /api/webhooks/harakapay
// HarakaPay posts { order_id, status, amount, net_amount, fee_amount, ... }
// when a payment completes or fails. There is no HMAC signature in the spec,
// so we verify the shared token (?t=) we embedded in webhook_url, then map the
// HarakaPay order_id back to our pending transaction and run the same
// processPaymentWebhook used by every other gateway.
// Always answers 200 so HarakaPay records delivery — except when the callback
// cannot be verified, which is a 401 and is documented in
// lib/payments/webhook-auth.ts (it fails closed, and settlement does not depend
// on this route).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { processPaymentWebhook } from "@/lib/services/webhook.service";
import type { HarakaWebhookPayload } from "@/lib/payments/harakapay";
import { harakaStatusToInternal } from "@/lib/payments/harakapay";
import { verifyWebhookToken } from "@/lib/webhook-auth";

export async function POST(request: NextRequest) {
  try {
    // 1. Shared-token check (webhook_url carried ?t=<token>). The decision
    //    table lives in webhook-auth.ts: it fails closed when the deployment
    //    has no token, because a callback we cannot verify is not one we may
    //    act on.
    const check = verifyWebhookToken({
      provided: request.nextUrl.searchParams.get("t") || "",
      configured: config.harakaPay.webhookToken,
      nodeEnv: config.nodeEnv,
    });
    if (!check.ok) {
      if (check.reason === "not-configured") {
        // A configuration fault, not an attack — and worth its own line, since
        // the symptom otherwise looks like the gateway being down.
        console.error(
          "[HarakaPay Webhook] Refused: HARAKAPAY_WEBHOOK_TOKEN is not configured, so this callback cannot be verified"
        );
      } else {
        console.error("[HarakaPay Webhook] Invalid token");
      }
      // Same body either way: which of the two it was is not the caller's
      // business.
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const payload: HarakaWebhookPayload = await request.json();

    if (!payload?.order_id) {
      return NextResponse.json({ error: "order_id missing" }, { status: 400 });
    }

    // 2. Map HarakaPay order_id -> our transaction
    const transaction = await prisma.transaction.findFirst({
      where: { providerRef: payload.order_id },
      select: { id: true, amount: true, status: true },
    });

    if (!transaction) {
      // Unknown order: acknowledge so HarakaPay stops retrying, but log it
      console.warn(`[HarakaPay Webhook] Unknown order: ${payload.order_id}`);
      return NextResponse.json({ status: "ok" });
    }

    const status = harakaStatusToInternal(payload.status);
    if (!status) {
      // pending/unknown states — nothing to do yet
      return NextResponse.json({ status: "ok" });
    }

    if (transaction.status !== "PENDING") {
      // Idempotent: already fulfilled (duplicate delivery)
      return NextResponse.json({ status: "ok" });
    }

    // 3. Fulfill through the shared webhook processor (70/30 split, access, etc.)
    //    Amount comes from OUR transaction row — never trust the caller's number.
    await processPaymentWebhook({
      orderId: transaction.id,
      transactionId: payload.order_id,
      amount: transaction.amount,
      status,
      provider: "HARAKAPAY",
      metadata: {
        netAmount: payload.net_amount,
        feeAmount: payload.fee_amount,
        completedAt: payload.completed_at,
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("[HarakaPay Webhook Error]", error);
    // 200 even on error: prevents endless retries while we investigate
    return NextResponse.json({ status: "ok" });
  }
}
