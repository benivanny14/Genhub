// =============================================================================
// GENHUB - SonicPesa Webhook Handler
// POST /api/webhooks/sonicpesa
//
// SonicPesa posts
//   { event, order_id, status, amount, currency, transid, channel, reference,
//     msisdn, timestamp }
// when a payment succeeds or fails. `order_id` is the gateway's own id, which we
// stored as the pending transaction's providerRef when create_order returned it,
// so the callback maps straight back to our row and runs the same
// processPaymentWebhook used by every other gateway.
//
// Verification lives in lib/webhook-auth.ts: an HMAC-SHA256 signature over the
// RAW body (`X-SonicPesa-Signature`) when the API secret is configured,
// otherwise the shared ?t= token, failing closed in production when neither is
// set. Webhooks are configured in the SonicPesa dashboard — there is no
// per-request webhook_url — so the URL to register there is
//   https://<domain>/api/webhooks/sonicpesa?t=<SONICPESA_WEBHOOK_TOKEN>
// (the query string is unnecessary when the secret key is configured).
//
// Always answers 200 so SonicPesa records delivery — except when the callback
// cannot be verified, which is a 401 and is documented in lib/webhook-auth.ts
// (it fails closed, and settlement does not depend on this route).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { readRawBodyCapped, MAX_WEBHOOK_BODY_BYTES } from "@/lib/request-body";
import { processPaymentWebhook } from "@/lib/services/webhook.service";
import type { SonicPesaWebhookPayload } from "@/lib/payments/sonicpesa";
import { sonicpesaStatusToInternal, sonicpesaPayoutEventToStatus } from "@/lib/payments/sonicpesa";
import { settlePayoutFromGateway } from "@/lib/services/payout-disbursement.service";
import {
  PAYMENT_EVENT,
  recordPaymentEvent,
} from "@/lib/services/payment-journey.service";
import { verifySonicPesaWebhook, verifyWebhookToken } from "@/lib/webhook-auth";

/** Derive a verdict from the event name when the body carries no status. */
function statusFromEvent(event: string, status: string | undefined) {
  const mapped = status ? sonicpesaStatusToInternal(status) : null;
  if (mapped) return mapped;

  const e = (event || "").toLowerCase();
  if (e === "payment.completed") return "SUCCESS" as const;
  if (e === "payment.failed" || e === "payment.cancelled") return "FAILED" as const;
  return null;
}


export async function POST(request: NextRequest) {
  try {
    const providedToken = request.nextUrl.searchParams.get("t") || "";
    const providedSignature = request.headers.get("x-sonicpesa-signature") || "";
    const usesSignature = Boolean(config.sonicPesa.secretKey);

    // 1. When no secret key is configured, the shared ?t= token is the only
    //    proof — checked FIRST, so an unverifiable callback is refused before its
    //    body is parsed. Fails closed in production when no token is set.
    if (!usesSignature) {
      const tokenCheck = verifyWebhookToken({
        provided: providedToken,
        configured: config.sonicPesa.webhookToken,
        nodeEnv: config.nodeEnv,
      });
      if (!tokenCheck.ok) {
        if (tokenCheck.reason === "not-configured") {
          console.error(
            "[SonicPesa Webhook] Refused: SONICPESA_WEBHOOK_TOKEN is not configured and no SONICPESA_SECRET_KEY is set, so this callback cannot be verified"
          );
        } else {
          console.error("[SonicPesa Webhook] Invalid token");
        }
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    // The signature is over the RAW body, so the bytes are read (bounded) and
    // verified before they are parsed — a callback that is not theirs never
    // reaches `JSON.parse`.
    const raw = await readRawBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
    if (!raw.ok || !raw.text.trim()) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    // 2. With a secret key configured, the signed body itself is the proof.
    if (usesSignature) {
      const check = verifySonicPesaWebhook({
        rawBody: raw.text,
        providedSignature,
        providedToken,
        secretKey: config.sonicPesa.secretKey,
        webhookToken: config.sonicPesa.webhookToken,
        nodeEnv: config.nodeEnv,
      });
      if (!check.ok) {
        console.error(
          check.reason === "not-configured"
            ? "[SonicPesa Webhook] Refused: the callback carried no signature"
            : "[SonicPesa Webhook] Invalid signature"
        );
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    let payload: SonicPesaWebhookPayload;
    try {
      payload = JSON.parse(raw.text) as SonicPesaWebhookPayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    /*
     * Payouts ride the same endpoint but are a different envelope: no order_id,
     * and the id we match on is `data.withdrawal_id` — the gateway id we stored
     * when we asked it to send. Handled before the order_id requirement below,
     * because a payout callback has none and would otherwise be answered with a
     * 400 that the gateway would keep retrying.
     */
    const payoutStatus = sonicpesaPayoutEventToStatus(payload.event);
    if (payoutStatus) {
      const withdrawalId = payload.data?.withdrawal_id;
      if (!withdrawalId) {
        console.warn(`[SonicPesa Webhook] Payout event with no withdrawal_id: ${payload.event}`);
        return NextResponse.json({ status: "ok" });
      }

      const settlement = await settlePayoutFromGateway({
        withdrawalId,
        gatewayStatus: payload.data?.status || payoutStatus,
        source: "webhook",
        fee: payload.data?.fee === undefined ? undefined : Number(payload.data.fee),
        netAmount:
          payload.data?.net_amount === undefined ? undefined : Number(payload.data.net_amount),
      });

      console.log(`[SonicPesa Webhook] Payout ${withdrawalId}: ${settlement.detail}`);
      return NextResponse.json({ status: "ok" });
    }

    // SonicPesa names the field `order_id`; accept a camelCase sibling too so a
    // future envelope tweak does not silently drop settlements.
    const orderId =
      (payload.order_id as string | undefined) ||
      ((payload as unknown as { orderId?: string }).orderId ?? "");
    if (!orderId) {
      return NextResponse.json({ error: "order_id missing" }, { status: 400 });
    }

    // 3. Map the gateway order id -> our transaction (it is stored as providerRef)
    const transaction = await prisma.transaction.findFirst({
      where: { providerRef: orderId },
      select: { id: true, amount: true, status: true },
    });

    if (!transaction) {
      // Unknown order: acknowledge so SonicPesa stops retrying, but log it.
      console.warn(`[SonicPesa Webhook] Unknown order: ${orderId}`);
      return NextResponse.json({ status: "ok" });
    }

    const status = statusFromEvent(payload.event, payload.status);
    if (!status) {
      // PENDING / INPROGRESS and other in-flight states — nothing to do yet.
      // Recorded anyway: "a webhook arrived and said nothing decisive" is a
      // different fact from "no webhook ever arrived", and an operator debugging
      // a stuck charge needs to be able to tell them apart.
      await recordPaymentEvent({
        transactionId: transaction.id,
        kind: PAYMENT_EVENT.webhookIgnored,
        detail: `Callback received with no decisive status (event: ${payload.event || "unknown"}).`,
        metadata: { event: payload.event ?? null, status: payload.status ?? null },
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
      detail: `Verified SonicPesa callback — verdict ${status}.`,
      metadata: {
        event: payload.event ?? null,
        gatewayStatus: payload.status ?? null,
        channel: payload.channel ?? null,
      },
    });

    // 4. Fulfil through the shared webhook processor (70/30 split, access, etc.)
    //    Amount comes from OUR transaction row — never trust the caller's number.
    await processPaymentWebhook({
      orderId: transaction.id,
      transactionId: orderId,
      amount: transaction.amount,
      status,
      provider: "SONICPESA",
      metadata: {
        completedAt: payload.timestamp,
        channel: payload.channel,
        gatewayStatus: payload.status,
        gatewayReference: payload.reference,
      },
    });

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("[SonicPesa Webhook Error]", error);
    // 200 even on error: prevents endless retries while we investigate.
    return NextResponse.json({ status: "ok" });
  }
}
