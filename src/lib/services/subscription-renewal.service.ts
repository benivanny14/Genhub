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
import {
  harakaCollect,
  harakaErrorReason,
  floatGate,
  HarakaFloatEmptyError,
  type FloatGate,
} from "../payments/harakapay";
import { generateOrderId } from "../utils";
import { grantSubscription, resyncSubscriberCount } from "./subscription.service";
import { debitWallet } from "./balance.service";

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

/** The row shape every decision about a due membership is made from. */
export interface RenewalCandidate {
  id: string;
  viewerId: string;
  creatorId: string;
  price: number;
  expiresAt: Date;
  renewAttempts: number;
  lastRenewAttemptAt: Date | null;
  renewPhone: string | null;
  creator: { displayName: string | null };
}

/**
 * What a due membership is owed, before anything is asked of the gateway.
 *
 * Four states, and the wording is the reason this is a function rather than
 * three `if`s inside the loop: the same answer is needed twice — once by the
 * worker that charges, once by the preview that says what charging would do —
 * and two copies of a money decision that can drift apart is exactly the pair of
 * behaviours a preview must not have.
 *
 *  * `charge` — nothing in the way.
 *  * `skip`   — out of attempts inside the paid period, or inside the retry gap.
 *               The membership keeps working; there is simply nothing to do yet.
 *  * `lapse`  — out of attempts with the period ended, or the period ended long
 *               enough ago that charging now would bill for time the fan did not
 *               have. The membership is closed here.
 *
 * Pure, so every boundary is pinned by a test that needs no database.
 */
export type RenewalGate =
  | { action: "charge" }
  | { action: "skip"; reason: string }
  | { action: "lapse"; reason: string };

export function renewalGate(sub: RenewalCandidate, now: Date): RenewalGate {
  // Bounded on purpose: an out-of-retries membership inside its paid period is
  // left alone until it ends, and one that has ended is closed here. Without the
  // cap, a permanent failure (a phone that never answers) would be retried
  // forever, one charge request per run.
  if (sub.renewAttempts >= MAX_RENEW_ATTEMPTS) {
    return sub.expiresAt <= now
      ? { action: "lapse", reason: `out of attempts (${MAX_RENEW_ATTEMPTS}) and the period has ended` }
      : { action: "skip", reason: `out of attempts (${MAX_RENEW_ATTEMPTS}) with time left on the period` };
  }

  // If the cron was down for months, waking up and billing every stale
  // membership at once would be a nasty surprise. Past the grace window the fan
  // has to re-subscribe deliberately.
  if (sub.expiresAt.getTime() < now.getTime() - STALE_WINDOW_MS) {
    return {
      action: "lapse",
      reason: `the period ended more than ${STALE_WINDOW_MS / 86400_000} days ago`,
    };
  }

  if (sub.lastRenewAttemptAt && now.getTime() - sub.lastRenewAttemptAt.getTime() < RETRY_GAP_MS) {
    return { action: "skip", reason: `an attempt was made less than ${RETRY_GAP_MS / 3600_000} hours ago` };
  }

  return { action: "charge" };
}

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
  /**
   * Held back because the merchant float is empty, so no prompt could be
   * delivered. Counted apart from `failed` because it is NOT the fan's fault:
   * the attempt budget is untouched, no notification is sent, and the retry gap
   * does not apply — the charge goes out by itself on the next run after the
   * float is topped up. A number here is an operator's to-do, not a fan's.
   */
  skippedNoFloat: number;
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
  skippedNoFloat: 0,
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

    // Out of attempts, stale, or inside the retry gap — the three reasons a due
    // membership is not charged, in the order the preview reports them too.
    const gate = renewalGate(sub, now);
    if (gate.action === "lapse") {
      await lapseSubscription(sub.id, sub.creatorId);
      result.failed += 1;
      continue;
    }
    if (gate.action === "skip") {
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
      else if (push.reason === "float-empty") result.skippedNoFloat += 1;
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
// What a run would do — asked without doing it
//
// This worker is the only one the supervisor will not start on its own, because
// it can push a charge request onto a fan's phone (see cron-hold-alert.service.ts).
// Refusing is right, and it leaves the person who has to press "Run now" with a
// blank question: charge how many, and of whom? The audit log answers that
// afterwards. This answers it first, from the same gate the worker uses, without
// creating a transaction, sending a prompt, or writing a heartbeat — the
// heartbeat is the record of what moved money, and nothing here moves any.
// =============================================================================

export interface RenewalPreviewLine {
  subscriptionId: string;
  viewerId: string;
  creatorId: string;
  /** Null when the creator has no display name on record. */
  creatorName: string | null;
  /** TZS the fan would be charged. */
  price: number;
  /** How the money would be asked for. */
  method: "wallet" | "ussd";
  /** Where the USSD push would go. Only set for `method: "ussd"`. */
  phone?: string;
  /** What the fan's wallet holds, so a "wallet" line can be checked by hand. */
  walletBalance: number;
  expiresAt: Date;
}

export interface RenewalPreviewSkipped {
  subscriptionId: string;
  reason: string;
}

export interface RenewalPreview {
  /** Due memberships looked at. */
  considered: number;
  /** How many would be charged if the worker ran now. */
  wouldCharge: number;
  fromWallet: number;
  byPhone: number;
  /** Due, but held back — each with the reason the worker would give. */
  notCharged: RenewalPreviewSkipped[];
  /** The chargeable ones, named, so a person can recognise who they are. */
  lines: RenewalPreviewLine[];
  /** Rows the preview could not read. Never silently zero. */
  errors: number;
  /**
   * What the float gate said when a USSD push was on the table, or null when
   * nobody would have been charged by phone. Included so the preview and the
   * worker cannot disagree: the preview says "would charge", and the worker it
   * describes holds exactly the lines this state refuses.
   */
  float: { state: FloatGate["state"]; floatTzs: number | null } | null;
}

/**
 * What renewing right now would charge, without charging it.
 *
 * Read-only in the strong sense: no transaction row, no membership change, no
 * attempt counter, no notification, no USSD push. The only writes anywhere near
 * this are the ones the gateway makes, and it is not called.
 */
export async function previewDueRenewals(options?: {
  limit?: number;
  now?: Date;
}): Promise<RenewalPreview> {
  const limit = options?.limit ?? 200;
  const now = options?.now ?? new Date();
  const preview: RenewalPreview = {
    considered: 0,
    wouldCharge: 0,
    fromWallet: 0,
    byPhone: 0,
    notCharged: [],
    lines: [],
    errors: 0,
    float: null,
  };

  const due = await prisma.creatorSubscription.findMany({
    where: {
      isActive: true,
      autoRenew: true,
      expiresAt: { lte: new Date(now.getTime() + RENEW_LEAD_MS) },
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
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });

  /** One gateway reading shared by every USSD line below, or null until needed. */
  let float: FloatGate | null = null;

  for (const sub of due) {
    preview.considered += 1;

    const gate = renewalGate(sub, now);
    if (gate.action !== "charge") {
      preview.notCharged.push({ subscriptionId: sub.id, reason: gate.reason });
      continue;
    }

    try {
      // A pending renewal checkout blocks a new attempt whatever its age — a late
      // settlement is honoured, so a second charge could extend the membership
      // twice for one payment. The sweeper clears abandoned ones after an hour.
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
        preview.notCharged.push({
          subscriptionId: sub.id,
          reason: "a renewal checkout from an earlier attempt is still awaiting approval",
        });
        continue;
      }

      const wallet = await prisma.user.findUnique({
        where: { id: sub.viewerId },
        select: { walletBalance: true },
      });
      const walletBalance = wallet?.walletBalance ?? 0;

      // The same order of preference the worker uses: the wallet if it covers the
      // price, and a USSD push only when it does not.
      const method: "wallet" | "ussd" =
        walletBalance >= sub.price ? "wallet" : "ussd";
      const phone =
        method === "ussd"
          ? sub.renewPhone || (await lastGatewayPhone(sub.viewerId, sub.creatorId))
          : null;

      if (method === "ussd" && !phone) {
        preview.notCharged.push({
          subscriptionId: sub.id,
          reason: `wallet holds TZS ${walletBalance.toLocaleString("en-US")} against a TZS ${sub.price.toLocaleString(
            "en-US"
          )} price and no phone number is on file`,
        });
        continue;
      }

      // The float gate, read once and only when a prompt is what a run would
      // send: the wallet path needs no float, so a preview of wallet-only
      // renewals never contacts the gateway. Without this the preview would
      // promise a fan a USSD charge that the worker quietly holds — the exact
      // disagreement this function exists to prevent, told the other way round.
      if (method === "ussd") {
        float = float ?? (await floatGate());
        preview.float = { state: float.state, floatTzs: float.floatTzs };
        if (float.state === "empty") {
          preview.notCharged.push({
            subscriptionId: sub.id,
            reason:
              "the HarakaPay float is empty, so no USSD prompt can be delivered — " +
              "top it up and the next run charges this fan",
          });
          continue;
        }
      }

      preview.wouldCharge += 1;
      if (method === "wallet") preview.fromWallet += 1;
      else preview.byPhone += 1;
      preview.lines.push({
        subscriptionId: sub.id,
        viewerId: sub.viewerId,
        creatorId: sub.creatorId,
        creatorName: sub.creator.displayName,
        price: sub.price,
        method,
        ...(phone ? { phone } : {}),
        walletBalance,
        expiresAt: sub.expiresAt,
      });
    } catch (error) {
      preview.errors += 1;
      console.warn(
        `[Renewal Preview] Could not read a due membership (${sub.id}):`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return preview;
}

/**
 * One sentence for a person: what pressing "Run now" would charge.
 *
 * Shared by the supervisor's response and the alert that reaches an operator, so
 * the bell and the log cannot disagree about the number.
 */
export function summarizeRenewalPreview(preview: RenewalPreview): string {
  // Named whenever a USSD line was held, in either branch: "3 by USSD push"
  // without it would be a promise the worker does not keep today.
  const heldByFloat =
    preview.float?.state === "empty"
      ? " (USSD renewals are held: the HarakaPay float is empty — top it up and they resume on their own)"
      : "";

  if (preview.wouldCharge === 0) {
    const held = preview.notCharged.length > 0 ? ", and none of them is chargeable" : "";
    return `A run now would charge nobody (${preview.considered} due${held})${heldByFloat}`;
  }

  return (
    `A run now would charge ${preview.wouldCharge} membership(s): ` +
    `${preview.fromWallet} from wallet, ${preview.byPhone} by USSD push to a fan's phone` +
    heldByFloat
  );
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
    // (a video purchase, a tip…), it refuses and nothing is touched. Shared with
    // every other wallet spend, so the renewal worker and a fan checking out at
    // the same instant cannot both take the same money.
    const debited = await debitWallet(tx, { userId: viewerId, amount: price });
    if (!debited.ok) return null;

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

/**
 * How a renewal push ended.
 *
 * `float-empty` is separated from the ordinary failure on purpose: the fan did
 * nothing wrong and nothing was asked of their phone, so a run must not spend
 * one of their attempts, tell them anything, or make them wait out the retry
 * gap. The membership simply waits for the float to come back — and it resumes
 * on its own, because the reading that refused it is cached for one minute
 * (FLOAT_CACHE_MS), so the next hourly run after a top-up pushes normally.
 */
type RenewalPushOutcome =
  | { ok: true }
  | { ok: false; reason: "float-empty" }
  | { ok: false; reason: "gateway" };

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
}): Promise<RenewalPushOutcome> {
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

  // Local dev / sandbox: mirror production with a synthetic order id so the
  // status poll and webhook can map a callback onto this row.
  const sandbox =
    config.nodeEnv !== "production" &&
    (!config.harakaPay.apiKey || config.harakaPay.sandbox);

  // --- 0. Can a prompt be delivered at all? -------------------------------
  // Asked BEFORE the PENDING row exists, so a refusal leaves nothing behind: no
  // checkout that looks like a real attempt, nothing for the sweeper to clear,
  // and — the point — no attempt spent against the fan's retry budget. A float
  // that is empty is our problem, and a fan who is paying us every month must
  // not lose the last of their four attempts (and then their membership)
  // because our merchant account was unfunded. `harakaCollect` refuses the same
  // state again downstream; this one only exists so the refusal costs the fan
  // nothing at all.
  if (!sandbox) {
    const float = await floatGate();
    if (float.state === "empty") {
      console.warn(
        `[Renewal] Held ${subscriptionId}: the HarakaPay float is empty ` +
          `(TZS ${float.floatTzs ?? 0}), so a USSD prompt would never reach the fan. ` +
          "Nothing was asked of their phone; top up the float and the next run pushes normally."
      );
      return { ok: false, reason: "float-empty" };
    }
  }

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
      return { ok: false, reason: "gateway" };
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
    // The float emptied between the reading above and the push itself — the
    // reading is up to a minute old by design, so this window is real. The row
    // this attempt already created is closed as FAILED (it is not awaiting
    // anything), but the fan is not charged an attempt and is not told: the same
    // reasoning as the early refusal, one call later.
    if (error instanceof HarakaFloatEmptyError) {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: "FAILED",
          metadata: { renewal: true, refusal: "FLOAT_EMPTY", gatewayError: "float empty" },
        },
      });
      console.warn(
        `[Renewal] Held ${subscriptionId}: the HarakaPay float emptied before the push was sent.`
      );
      return { ok: false, reason: "float-empty" };
    }

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
    return { ok: false, reason: "gateway" };
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
