// =============================================================================
// GENHUB - Sandbox Payment Completion (DEVELOPMENT ONLY)
// POST /api/dev/sandbox/complete - Marks a pending transaction as paid by
// running it through the same processPaymentWebhook used for real gateway
// callbacks (70/30 split, holding period, video access grant).
// Disabled in production.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import { processPaymentWebhook } from "@/lib/services/webhook.service";

export async function POST(request: NextRequest) {
  // This endpoint marks a PENDING transaction as paid without any money moving,
  // so it may only exist while the gateway integration itself is in sandbox
  // mode. The moment PAYMENT_SANDBOX=false + an API key are configured (i.e.
  // real charges), it refuses — otherwise anyone could mint a free purchase.
  const sandboxMode =
    config.nodeEnv !== "production" &&
    (!config.harakaPay.apiKey || config.harakaPay.sandbox);

  if (!sandboxMode) {
    return api.error(
      "Sandbox completion is disabled — this deployment sends real gateway charges",
      403,
      "FORBIDDEN"
    );
  }

  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const orderId = typeof body?.orderId === "string" ? body.orderId : "";
    const status = body?.status === "FAILED" ? "FAILED" : "SUCCESS";

    if (!orderId) {
      return api.validation("orderId is required");
    }

    // Only the payer may complete their own sandbox order.
    // Accepts both our internal id and the hp_sbx_* providerRef that
    // /payments/purchase returns to the client.
    const transaction = await prisma.transaction.findFirst({
      where: { OR: [{ id: orderId }, { providerRef: orderId }] },
      select: { id: true, userId: true, amount: true, status: true },
    });

    if (!transaction) {
      return api.notFound("Order not found");
    }
    if (transaction.userId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden("This order does not belong to you");
    }
    if (transaction.status !== "PENDING") {
      return api.error(`This order has already been processed: ${transaction.status}`, 409, "ALREADY_PROCESSED");
    }

    const result = await processPaymentWebhook({
      orderId: transaction.id,
      transactionId: `SANDBOX-${Date.now()}`,
      amount: transaction.amount,
      status: status as "SUCCESS" | "FAILED",
      provider: "SANDBOX",
      metadata: { sandbox: true },
    });

    if (!result.processed) {
      return api.error(result.reason || "This order cannot be processed", 409, "NOT_PROCESSABLE");
    }

    return api.success(
      { processed: true, orderId: transaction.id, status },
      status === "SUCCESS" ? "Payment completed (sandbox)" : "Payment declined (sandbox)"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Sandbox Complete Error]", error);
    return api.internal();
  }
}
