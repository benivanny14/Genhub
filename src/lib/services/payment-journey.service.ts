// =============================================================================
// GENHUB - The journey of one charge
// =============================================================================
// Answers, for a single transaction, the questions an operator actually asks:
//
//   * How many times did we ask the gateway to collect, and when?
//   * What did the gateway say when it refused (the REAL gatewayError)?
//   * Did a webhook ever arrive — or is polling the only thing that settled it?
//   * What was the customer shown at each step?
//
// `Transaction.status` is one value and keeps only the last one, so it cannot
// answer any of that. Every step writes one append-only `PaymentEvent` row
// instead, and this reads them back in order.
//
// RECORDING NEVER THROWS. A timeline is a diagnostic; a payment must never fail
// because its own log did. Callers therefore use `void recordPaymentEvent(...)`
// freely, and a broken log shows up as a gap an operator can see rather than as
// a charge that could not start.
// =============================================================================

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/db";

/** The dotted codes. Kept together so the timeline cannot drift from the writer. */
export const PAYMENT_EVENT = {
  checkoutCreated: "checkout.created",
  collectStarted: "collect.started",
  collectRejected: "collect.rejected",
  collectFailed: "collect.failed",
  webhookReceived: "webhook.received",
  webhookIgnored: "webhook.ignored",
  settledSuccess: "settled.success",
  settledFailed: "settled.failed",
  investigationOpen: "investigation.open",
  checkoutExpired: "checkout.expired",
  adminAction: "admin.action",
} as const;

export type PaymentEventKind = (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

export async function recordPaymentEvent(entry: {
  transactionId: string;
  kind: string;
  detail?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.paymentEvent.create({
      data: {
        transactionId: entry.transactionId,
        kind: entry.kind,
        // A timeline entry is a line, not an essay nor a place to smuggle a body.
        detail: entry.detail ? entry.detail.slice(0, 500) : null,
        metadata: entry.metadata,
      },
    });
  } catch (error) {
    console.error(
      `[PaymentJourney] FAILED to record ${entry.kind} for ${entry.transactionId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * What the customer was shown for this state.
 *
 * Pure and separate so every screen that has to explain a charge — this panel,
 * a support script — can be checked against one description rather than
 * re-imagining what the buyer read.
 */
export function describeCustomerExperience(tx: {
  status: string;
  type: string;
  metadata: unknown;
}): string {
  const meta = (tx.metadata || {}) as Record<string, unknown>;

  switch (tx.status) {
    case "SUCCESS":
      return tx.type === "WALLET_TOPUP"
        ? "Wallet credited — the customer saw a success message."
        : "Access unlocked — the customer saw a success message.";
    case "REFUNDED":
      return "“Your payment was refunded.”";
    case "UNDER_INVESTIGATION":
      return "“We are still checking your last payment — please do not pay again.”";
    case "PENDING":
      return meta.expired === true
        ? "“This checkout expired — you can safely try again.”"
        : "“Check your phone and approve the mobile-money prompt with your PIN.”";
    case "FAILED":
      if (meta.renewal === true) {
        return "A renewal attempt failed — the customer was notified in-app and by email.";
      }
      if (meta.expired === true) {
        return "“This checkout expired — you can safely try again.”";
      }
      return "“We could not start the payment just now. Nothing has been charged.”";
    default:
      return "—";
  }
}

export interface PaymentJourney {
  transaction: {
    id: string;
    amount: number;
    status: string;
    type: string;
    gateway: string | null;
    providerRef: string | null;
    platformFee: number | null;
    creatorCut: number | null;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
    ageMinutes: number;
    viewer: { id: string; displayName: string | null; email: string | null; phone: string | null } | null;
    creator: { id: string; displayName: string | null } | null;
    video: { id: string; title: string } | null;
  };
  events: {
    id: string;
    kind: string;
    detail: string | null;
    metadata: unknown;
    at: string;
  }[];
  summary: {
    attempts: number;
    webhookArrived: boolean;
    lastWebhookAt: string | null;
    gatewayError: string | null;
    customerSaw: string;
    ageMinutes: number;
  };
}

export async function getPaymentJourney(
  transactionId: string
): Promise<PaymentJourney | null> {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: {
      viewer: { select: { id: true, displayName: true, email: true, phone: true } },
      creator: { select: { id: true, displayName: true } },
      video: { select: { id: true, title: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!tx) return null;

  const meta = (tx.metadata || {}) as Record<string, unknown>;
  const gatewayError = typeof meta.gatewayError === "string" ? meta.gatewayError : null;

  const attempts = tx.events.filter((e) => e.kind === PAYMENT_EVENT.collectStarted).length;
  const webhookEvents = tx.events.filter((e) => e.kind === PAYMENT_EVENT.webhookReceived);
  const lastWebhookAt = webhookEvents.length
    ? webhookEvents[webhookEvents.length - 1].createdAt.toISOString()
    : null;

  const ageMinutes = Math.floor((Date.now() - tx.createdAt.getTime()) / 60_000);

  return {
    transaction: {
      id: tx.id,
      amount: tx.amount,
      status: tx.status,
      type: tx.type,
      gateway: tx.gateway,
      providerRef: tx.providerRef,
      platformFee: tx.platformFee,
      creatorCut: tx.creatorCut,
      metadata: tx.metadata,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
      ageMinutes,
      viewer: tx.viewer,
      creator: tx.creator,
      video: tx.video,
    },
    events: tx.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      detail: e.detail,
      metadata: e.metadata,
      at: e.createdAt.toISOString(),
    })),
    summary: {
      attempts,
      webhookArrived: webhookEvents.length > 0,
      lastWebhookAt,
      gatewayError,
      customerSaw: describeCustomerExperience({
        status: tx.status,
        type: tx.type,
        metadata: tx.metadata,
      }),
      ageMinutes,
    },
  };
}
