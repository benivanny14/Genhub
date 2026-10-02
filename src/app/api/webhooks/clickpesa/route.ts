// =============================================================================
// GENHUB - ClickPesa Webhook Handler
// POST /api/webhooks/clickpesa
//
// ClickPesa posts { event, data: { orderReference, status, collectedAmount, … } }
// when a payment succeeds or fails. The reference is one WE generated and stored
// as the pending transaction's providerRef, so the callback maps straight back to
// our row and runs the same processPaymentWebhook used by every other gateway.
//
// Verification lives in lib/webhook-auth.ts: a checksum (HMAC-SHA256) when a
// checksum key is configured, otherwise the shared ?t= token, failing closed in
// production when neither is set. Webhooks are configured in the ClickPesa
// dashboard — there is no per-request webhook_url — so the URL to register there
// is  https://<domain>/api/webhooks/clickpesa?t=<CLICKPESA_WEBHOOK_TOKEN>
// (the query string is optional when checksum signing is enabled).
//
// Always answers 200 so ClickPesa records delivery — except when the callback
// cannot be verified, which is a 401 and is documented in lib/webhook-auth.ts
// (it fails closed, and settlement does not depend on this route).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { readJsonBody, MAX_WEBHOOK_BODY_BYTES } from "@/lib/request-body";
import { processPaymentWebhook } from "@/lib/services/webhook.service";
import type { ClickPesaWebhookPayload } from "@/lib/payments/clickpesa";
import { clickpesaStatusToInternal } from "@/lib/payments/clickpesa";
import {
  PAYMENT_EVENT,
  recordPaymentEvent,
} from "@/lib/services/payment-journey.service";
import { verifyClickPesaWebhook, verifyWebhookToken } from "@/lib/webhook-auth";

/** Derive a verdict from the event name when the body carries no status. */
function statusFromEvent(event: string, status: string | undefined) {
  const mapped = status ? clickpesaStatusToInternal(status) : null;
  if (mapped) return mapped;

  const e = (event || "").toUpperCase();
  if (e === "PAYMENT RECEIVED") return "SUCCESS" as const;
  if (e === "PAYMENT FAILED") return "FAILED" as const;
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const providedToken = request.nextUrl.searchParams.get("t") || "";
    const usesChecksum = Boolean(config.clickPesa.checksumKey);

    // 1. When no checksum key is configured, the shared ?t= token is the only
    //    proof — checked FIRST, so an unverifiable callback is refused before its
    //    body is parsed. Fails closed in production when no token is set.
    if (!usesChecksum) {
      const tokenCheck = verifyWebhookToken({
        provided: providedToken,
        configured: config.clickPesa.webhookToken,
        nodeEnv: config.nodeEnv,
      });
      if (!tokenCheck.ok) {
        if (tokenCheck.reason === "not-configured") {
          console.error(
            "[ClickPesa Webhook] Refused: CLICKPESA_WEBHOOK_TOKEN is not configured and no CLICKPESA_CHECKSUM_KEY is set, so this callback cannot be verified"
          );
        } else {
          console.error("[ClickPesa Webhook] Invalid token");
        }
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    const payload = (await readJsonBody(request, null, MAX_WEBHOOK_BODY_BYTES)) as
      | ClickPesaWebhookPayload
      | null;

    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    // 2. With checksum signing enabled, the signed body itself is the proof.
    if (usesChecksum) {
      const check = verifyClickPesaWebhook({
        payload: payload as unknown as Record<string, unknown>,
        providedToken,
        checksumKey: config.clickPesa.checksumKey,
        webhookToken: config.clickPesa.webhookToken,
        nodeEnv: config.nodeEnv,
      });
      if (!check.ok) {
        console.error(
          check.reason === "not-configured"
            ? "[ClickPesa Webhook] Refused: the callback carried no checksum"
            : "[ClickPesa Webhook] Invalid checksum"
        );
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    const orderReference = payload.data?.orderReference;
    if (!orderReference) {
      return NextResponse.json({ error: "orderReference missing" }, { status: 400 });
    }

    // 3. Map our order reference -> our transaction
    const transaction = await prisma.transaction.findFirst({
      where: { providerRef: orderReference },
      select: { id: true, amount: true, status: true },
    });

    if (!transaction) {
      // Unknown order: acknowledge so ClickPesa stops retrying, but log it.
      console.warn(`[ClickPesa Webhook] Unknown order: ${orderReference}`);
      return NextResponse.json({ status: "ok" });
    }

    const status = statusFromEvent(payload.event, payload.data?.status);
    if (!status) {
      // PROCESSING / PENDING and other in-flight states — nothing to do yet.
      // Recorded anyway: "a webhook arrived and said nothing decisive" is a
      // different fact from "no webhook ever arrived", and an operator debugging
      // a stuck charge needs to be able to tell them apart.
      await recordPaymentEvent({
        transactionId: transaction.id,
        kind: PAYMENT_EVENT.webhookIgnored,
        detail: `Callback received with no decisive status (event: ${payload.event || "unknown"}).`,
        metadata: { event: payload.event ?? null, status: payload.data?.status ?? null },
      });
      return NextResponse.json({ status: "ok" });
    }

    if (transaction.status !== "PENDING") {
      // Idempotent: already fulfilled (duplicate delivery).
      await recordPaymentEvent({
        transactionId: transaction.id,
        kind: PAYMENT_EVENT.webhookIgnored,
        detail: `Duplicate callback ignored — the charge is already ${transaction.status}.`,
        metadata: { event: payload.event ?? null, incomingStatus: status },
      });
      return NextResponse.json({ status: "ok" });
    }

    // The proof this route exists to provide: a verified callback DID arrive,
    // and when. From here the settlement engine takes over and appends its own.
    await recordPaymentEvent({
      transactionId: transaction.id,
      kind: PAYMENT_EVENT.webhookReceived,
      detail: `Verified ClickPesa callback — verdict ${status}.`,
      metadata: {
        event: payload.event ?? null,
        gatewayStatus: payload.data?.status ?? null,
        channel: payload.data?.channel ?? null,
      },
    });

    // 4. Fulfil through the shared webhook processor (70/30 split, access, etc.)
    //    Amount comes from OUR transaction row — never trust the caller's number.
    await processPaymentWebhook({
      orderId: transaction.id,
      transactionId: orderReference,
      amount: transaction.amount,
      status,
      provider: "CLICKPESA",
      metadata: {
        completedAt: payload.data?.updatedAt,
        channel: payload.data?.channel,
        gatewayStatus: payload.data?.status,
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("[ClickPesa Webhook Error]", error);
    // 200 even on error: prevents endless retries while we investigate.
    return NextResponse.json({ status: "ok" });
  }
}
