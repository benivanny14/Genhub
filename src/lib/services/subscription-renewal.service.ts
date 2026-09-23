// =============================================================================
// GENHUB - Subscription auto-renewal
//
// A membership renews in the 24h before it expires. The order of preference is:
//
//   1. WALLET  — instant, no phone needed, settled in a single transaction.
//   2. HARAKAPAY USSD push — used when the wallet cannot cover the price but we
//      have the phone number the fan originally paid with (remembered on the
//      subscription as `renewPhone`, or recovered from their last gateway
//      checkout). The push is settled by the normal webhook/status poll.
//   3. Neither works — record the reason, notify the fan, and retry after a gap
//      until the attempt budget runs out. Then the membership lapses and the fan
//      has to re-subscribe, exactly like OnlyFans.
//
// Invariants:
//   * A membership is NEVER extended without money moving in the same
//     transaction (grantSubscription is always called with the debit).
//   * Only one attempt per RETRY_GAP, at most MAX_RENEW_ATTEMPTS per period, and
//     never a second charge while a previous one is still pending (whatever its
//     age) — otherwise the fan gets a storm of prompts, and a late settlement
//     of the old charge would extend the membership a second time.
//   * A membership that lapsed more than STALE_WINDOW ago is NEVER charged:
//     the fan re-subscribes deliberately instead of being billed for months of
//     downtime the moment the scheduler comes back.
//   * A late settlement is always honoured: the PENDING renewal transaction is
//     a real checkout that processPaymentWebhook settles normally.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { harakaCollect, harakaErrorReason } from "../payments/harakapay";
import { generateOrderId } from "../utils";
import { grantSubscription, resyncSubscriberCount } from "./subscription.service";

/** Start trying this long before the membership expires. */
export const RENEW_LEAD_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between two attempts for the same membership. */
export const RETRY_GAP_MS = 6 * 60 * 60 * 1000;
/** How many failed attempts before we stop and let the membership lapse. */
export const MAX_RENEW_ATTEMPTS = 4;
/**
 * A membership that lapsed longer ago than this is never charged again — the
 * fan has to re-subscribe deliberately. Protects against a cron that was down
 * for a while billing every stale membership the moment it comes back.
 */
export const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RenewalResult {
  /** Memberships inside the renewal window that were looked at. */
  considered: number;
  /** Paid instantly from the wallet balance. */
  renewedFromWallet: number;
  /** A USSD push was sent; the fan must approve it on their phone. */
  pushedToPhone: number;
  /** An earlier push is still awaiting approval — nothing to do this run. */
  awaitingApproval: number;
  /** Out of retries or nothing to pay with — membership left to lapse. */
  failed: number;
  /** Not due yet, turned off, or outside the processable window. */
  skipped: number;
  errors: number;
}

const zero = (): RenewalResult => ({
  considered: 0,
  renewedFromWallet: 0,
  pushedToPhone: 0,
  awaitingApproval: 0,
  failed: 0,
  skipped: 0,
  errors: 0,
});

/**
 * Charge every membership that is about to expire.
 *
 * @param options.limit      Max memberships to process in one run (default 200).
 * @param options.viewerId   Scope to one fan (support tooling + tests).
 * @param options.now        Override "now" (tests).
 */
export async function renewDueSubscriptions(options?: {
  limit?: number;
  viewerId?: string;
  now?: Date;
}): Promise<RenewalResult> {
  const limit = options?.limit ?? 200;
  const now = options?.now ?? new Date();
  const result = zero();

  const due = await prisma.creatorSubscription.findMany({
    where: {
      isActive: true,
      autoRenew: true,
      expiresAt: { lte: new Date(now.getTime() + RENEW_LEAD_MS) },
      ...(options?.viewerId ? { viewerId: options.viewerId } : {}),
    },
    select: {
      id: true,
      viewerId: true,
      creatorId: true,
      price: true,
      expiresAt: true,
      renewAttempts: true,
      lastRenewAttemptAt: true,
      renewPhone: true,
      creator: { select: { displayName: true } },
      viewer: { select: { displayName: true } },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });

  for (const sub of due) {
    result.considered += 1;

    // --- Out of retries ------------------------------------------------------
    // Bounded on purpose: an out-of-retries membership inside its paid period is
    // left alone until it ends, and one that has ended is closed here. Without
    // the cap a permanent failure (a lapsed card, a phone that never answers)
    // would be retried forever, every RETRY_GAP, at one login attempt per run.
    if (sub.renewAttempts >= MAX_RENEW_ATTEMPTS) {
      if (sub.expiresAt <= now) {
        await lapseSubscription(sub.id, sub.creatorId);
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
      continue;
    }

    // --- Never charge a membership that lapsed long ago ----------------------
    // If the cron was down for months, waking up and billing every stale
    // membership at once would be a nasty surprise. Past the grace window the
    // fan has to re-subscribe deliberately.
    if (sub.expiresAt.getTime() < now.getTime() - STALE_WINDOW_MS) {
      await lapseSubscription(sub.id, sub.creatorId);
      result.failed += 1;
      continue;
    }

    // --- Respect the retry gap ----------------------------------------------
    if (
      sub.lastRenewAttemptAt &&
      now.getTime() - sub.lastRenewAttemptAt.getTime() < RETRY_GAP_MS
    ) {
      result.skipped += 1;
      continue;
    }

    try {
      // --- A live renewal checkout already exists ---------------------------
      // ANY pending renewal checkout blocks a new attempt, however old.
      // A late settlement is honoured by design (processPaymentWebhook), so
      // starting a second charge here could extend the membership twice for one
      // payment. The sweeper (/api/cron/reconcile-payments) clears abandoned
      // ones after an hour, which releases this block.
      const pending = await prisma.transaction.findFirst({
        where: {
          userId: sub.viewerId,
          creatorId: sub.creatorId,
          type: "SUBSCRIPTION",
          status: "PENDING",
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });

      if (pending) {
        result.awaitingApproval += 1;
        continue;
      }

      // --- 1. Wallet covers it ----------------------------------------------
      const walletPaid = await renewFromWallet({
        subscriptionId: sub.id,
        viewerId: sub.viewerId,
        creatorId: sub.creatorId,
        price: sub.price,
        creatorName: sub.creator.displayName,
        expiresAt: sub.expiresAt,
      });
      if (walletPaid) {
        result.renewedFromWallet += 1;
        continue;
      }

      // --- 2. Fall back to a USSD push --------------------------------------
      const phone = sub.renewPhone || (await lastGatewayPhone(sub.viewerId, sub.creatorId));
      if (!phone) {
        await recordFailure({
          subscriptionId: sub.id,
          creatorId: sub.creatorId,
          userId: sub.viewerId,
          attempts: sub.renewAttempts,
          price: sub.price,
          creatorName: sub.creator.displayName,
          reason:
            "wallet balance is not enough and no phone number is on file for an automatic USSD charge",
        });
        result.failed += 1;
        continue;
      }

      const push = await pushRenewal({
        subscriptionId: sub.id,
        viewerId: sub.viewerId,
        creatorId: sub.creatorId,
        price: sub.price,
        phone,
        creatorName: sub.creator.displayName,
        expiresAt: sub.expiresAt,
        // Attempts on record BEFORE this one — the failure bookkeeping needs it
        // so the counter advances (and the retry budget is finite).
        attempts: sub.renewAttempts,
      });

      if (push.ok) result.pushedToPhone += 1;
      else result.failed += 1;
    } catch (error) {
      result.errors += 1;
      console.warn(
        `[Renewal] Failed for subscription ${sub.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return result;
}

// =============================================================================
// 1. Wallet renewal — one atomic transaction
// =============================================================================

async function renewFromWallet(params: {
  subscriptionId: string;
  viewerId: string;
  creatorId: string;
  price: number;
  creatorName: string | null;
  expiresAt: Date;
}): Promise<boolean> {
  const { subscriptionId, viewerId, creatorId, price, creatorName, expiresAt } = params;

  const outcome = await prisma.$transaction(async (tx) => {
    // Conditional debit: if the fan spent the balance between the read and here
    // (a video purchase, a tip…), count is 0 and nothing is touched.
    const debited = await tx.user.updateMany({
      where: { id: viewerId, walletBalance: { gte: price } },
      data: { walletBalance: { decrement: price } },
    });
    if (debited.count === 0) return null;

    const created = await tx.transaction.create({
      data: {
        userId: viewerId,
        creatorId,
        amount: price,
        type: "SUBSCRIPTION",
        status: "SUCCESS",
        gateway: null, // paid from the wallet, not a gateway charge
        metadata: {
          method: "wallet",
          renewal: true,
          subscriptionId,
          renewedFrom: expiresAt.toISOString(),
        },
      },
      select: { id: true },
    });

    const granted = await grantSubscription(tx, {
      viewerId,
      creatorId,
      amount: price,
      isRenewal: true,
    });

    await tx.transaction.update({
      where: { id: created.id },
      data: { platformFee: granted.platformFee, creatorCut: granted.creatorCut },
    });

    await tx.notification.create({
      data: {
        userId: viewerId,
        title: "Membership renewed ✅",
        message: `Your ${formatTZS(price)} monthly membership with ${
          creatorName || "the creator"
        } was renewed from your wallet balance.`,
        type: "success",
        link: "/billing",
      },
    });

    await tx.notification.create({
      data: {
        userId: creatorId,
        title: "Membership renewed ⭐",
        message: `A fan's ${formatTZS(price)} membership auto-renewed. You earned ${formatTZS(
          granted.creatorCut
        )} (held for ${config.business.holdingPeriodDays} days).`,
        type: "success",
        link: "/creator",
      },
    });

    return granted;
  });

  return outcome !== null;
}

// =============================================================================
// 2. USSD renewal — creates a normal PENDING checkout
// =============================================================================

async function pushRenewal(params: {
  subscriptionId: string;
  viewerId: string;
  creatorId: string;
  price: number;
  phone: string;
  creatorName: string | null;
  expiresAt: Date;
  /** Attempts already on record before this one. */
  attempts: number;
}): Promise<{ ok: boolean }> {
  const {
    subscriptionId,
    viewerId,
    creatorId,
    price,
    phone,
    creatorName,
    expiresAt,
    attempts,
  } = params;
  const orderId = generateOrderId("REN");

  const transaction = await prisma.transaction.create({
    data: {
      userId: viewerId,
      creatorId,
      amount: price,
      type: "SUBSCRIPTION",
      status: "PENDING",
      gateway: "HARAKAPAY",
      metadata: {
        orderId,
        plan: "monthly",
        phone,
        renewal: true,
        subscriptionId,
      },
    },
    select: { id: true },
  });

  // Local dev / sandbox: mirror production with a synthetic order id so the
  // status poll and webhook can map a callback onto this row.
  const sandbox =
    config.nodeEnv !== "production" &&
    (!config.harakaPay.apiKey || config.harakaPay.sandbox);

  if (sandbox) {
    const ref = `hp_sbx_${transaction.id}`;
    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: transaction.id },
        data: { providerRef: ref },
      }),
      prisma.creatorSubscription.update({
        where: { id: subscriptionId },
        data: {
          renewAttempts: { increment: 1 },
          lastRenewAttemptAt: new Date(),
          renewPhone: phone,
        },
      }),
    ]);
    return { ok: true };
  }

  const webhookUrl = `${config.appUrl}/api/webhooks/harakapay${
    config.harakaPay.webhookToken ? `?t=${config.harakaPay.webhookToken}` : ""
  }`;

  try {
    const response = await harakaCollect({
      phone,
      amount: price,
      description: `Genhub renewal - ${creatorName || "creator"}`,
      webhookUrl,
    });

    if (!response.success || !response.order_id) {
      const reason = response.error || "gateway rejected the renewal charge";
      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED", metadata: { renewal: true, gatewayError: reason } },
        }),
      ]);
      await recordFailure({
        subscriptionId,
        creatorId,
        userId: viewerId,
        attempts,
        price,
        creatorName,
        reason,
      });
      return { ok: false };
    }

    await prisma.$transaction([
      prisma.transaction.update({
        where: { id: transaction.id },
        data: { providerRef: response.order_id },
      }),
      prisma.creatorSubscription.update({
        where: { id: subscriptionId },
        data: {
          renewAttempts: { increment: 1 },
          lastRenewAttemptAt: new Date(),
          renewPhone: phone,
        },
      }),
      prisma.notification.create({
        data: {
          userId: viewerId,
          title: "Approve your renewal 📱",
          message: `We sent a USSD request to ${phone} to renew your ${formatTZS(
            price
          )} membership with ${creatorName || "the creator"}. Enter your PIN to keep access — it expires ${formatDate(
            expiresAt
          )}.`,
          type: "info",
          link: "/billing",
        },
      }),
    ]);

    return { ok: true };
  } catch (error) {
    const reason = harakaErrorReason(error);
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: "FAILED", metadata: { renewal: true, gatewayError: reason } },
    });
    await recordFailure({
      subscriptionId,
      creatorId,
      userId: viewerId,
      attempts,
      price,
      creatorName,
      reason,
    });
    console.warn(`[Renewal] HarakaPay rejected renewal for ${subscriptionId}: ${reason}`);
    return { ok: false };
  }
}

// =============================================================================
// Failure bookkeeping + notifications
// =============================================================================

/**
 * Record a failed attempt and tell the fan. The notification is sent on the
 * FIRST failure (so they can fix it early) and again on the LAST one (so the
 * expiry is never a surprise) — never on every run of the cron.
 */
async function recordFailure(params: {
  subscriptionId: string;
  creatorId: string;
  userId: string;
  /** Attempts already on record before this one. */
  attempts: number;
  price: number;
  creatorName: string | null;
  reason: string;
}): Promise<void> {
  const { subscriptionId, creatorId, userId, attempts, price, creatorName, reason } = params;
  const nextAttempts = attempts + 1;
  const exhausted = nextAttempts >= MAX_RENEW_ATTEMPTS;

  await prisma.creatorSubscription.update({
    where: { id: subscriptionId },
    data: {
      renewAttempts: nextAttempts,
      lastRenewAttemptAt: new Date(),
      lastRenewError: reason,
    },
  });

  if (attempts > 0 && !exhausted) return;

  await prisma.notification.create({
    data: {
      userId,
      title: exhausted ? "Your membership could not be renewed" : "Renewal needs your attention",
      message: exhausted
        ? `We could not renew your ${formatTZS(price)} membership with ${
            creatorName || "the creator"
          } (${reason}). You will lose access when the current period ends — you can re-subscribe any time.`
        : `We could not renew your ${formatTZS(price)} membership with ${
            creatorName || "the creator"
          } automatically: ${reason}. Top up your wallet (or wait for the USSD prompt) and we will try again.`,
      type: exhausted ? "error" : "warning",
      link: exhausted ? `/creator/${creatorId}` : "/payments",
    },
  });
}

/**
 * Attempts are exhausted and the period has ended: mark the membership inactive
 * and resync the creator's public subscriber counter. Access already stops at
 * `expiresAt`; this keeps the record and the counter honest.
 */
async function lapseSubscription(subscriptionId: string, creatorId: string): Promise<void> {
  await prisma.creatorSubscription.update({
    where: { id: subscriptionId },
    data: { isActive: false, autoRenew: false },
  });
  await resyncSubscriberCount(creatorId);
}

// =============================================================================
// Helpers
// =============================================================================

/** The phone the fan last sent a gateway charge from, if we still have it. */
async function lastGatewayPhone(
  viewerId: string,
  creatorId: string
): Promise<string | null> {
  const tx = await prisma.transaction.findFirst({
    where: { userId: viewerId, creatorId, gateway: "HARAKAPAY" },
    select: { metadata: true },
    orderBy: { createdAt: "desc" },
  });
  const meta = (tx?.metadata ?? {}) as { phone?: unknown };
  return typeof meta.phone === "string" && meta.phone.length > 0 ? meta.phone : null;
}

function formatTZS(amount: number): string {
  return `TZS ${amount.toLocaleString("en-US")}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
