// =============================================================================
// GENHUB - Payment Status API Route
// GET /api/payments/status/[orderId] - Poll a transaction's state.
// For HarakaPay this also reconciles against the gateway: if our row is still
// PENDING but HarakaPay already completed/failed it (webhook missed, local dev),
// we finalize through the same processPaymentWebhook and return fresh state.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import config from "@/lib/config";
import { harakaStatus, harakaStatusToInternal } from "@/lib/payments/harakapay";
import { processPaymentWebhook } from "@/lib/services/webhook.service";

export async function GET(
  _request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const auth = await requireAuth();
    const { orderId } = params;

    // Accept both our internal id AND the gateway order id (providerRef) —
    // clients receive HarakaPay's hp_* order id from /payments/purchase.
    let transaction = await prisma.transaction.findFirst({
      where: { OR: [{ id: orderId }, { providerRef: orderId }] },
      select: {
        id: true,
        userId: true,
        status: true,
        amount: true,
        providerRef: true,
        gateway: true,
        videoId: true,
      },
    });

    if (!transaction) return api.notFound("Order not found");
    if (transaction.userId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden("This order does not belong to you");
    }

    // Reconcile with HarakaPay while the answer is still open (webhook may not
    // have landed). UNDER_INVESTIGATION is included deliberately: the customer
    // tapping "Check status" is our earliest warning that a charge has finally
    // settled, and the broken webhook that caused the investigation is exactly
    // the reason we cannot wait for one to tell us. It also settles the
    // notification, so the customer finds out without an admin doing anything.
    if (
      (transaction.status === "PENDING" ||
        transaction.status === "UNDER_INVESTIGATION") &&
      transaction.gateway === "HARAKAPAY" &&
      transaction.providerRef &&
      config.harakaPay.apiKey &&
      !config.harakaPay.sandbox
    ) {
      try {
        const remote = await harakaStatus(transaction.providerRef);
        const internal = remote.payment
          ? harakaStatusToInternal(remote.payment.status)
          : null;

        if (internal) {
          await processPaymentWebhook({
            orderId: transaction.id,
            transactionId: transaction.providerRef,
            amount: transaction.amount,
            status: internal,
            provider: "HARAKAPAY",
            metadata: { reconciled: true },
          });

          transaction = await prisma.transaction.findUnique({
            where: { id: transaction.id },
            select: {
              id: true,
              userId: true,
              status: true,
              amount: true,
              providerRef: true,
              gateway: true,
              videoId: true,
            },
          });
        }
      } catch (reconcileError: any) {
        // Non-fatal: the webhook can still land later
        console.warn(
          "[Payment Status] HarakaPay reconcile failed:",
          reconcileError?.message || reconcileError
        );
      }
    }

    return api.success({
      orderId: transaction!.id,
      status: transaction!.status,
      amount: transaction!.amount,
      videoId: transaction!.videoId,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Payment Status Error]", error);
    return api.internal();
  }
}
