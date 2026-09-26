// =============================================================================
// GENHUB - The blue tick, bought by the month
//
// The verified badge used to be something only an admin could grant, which made
// it a favour: there was no way for a creator to ask for one, no way to pay for
// one, and no way for it to end. This service is the whole feature —
//
//   1. a creator buys a month (or several) for TZS 10,000 each, paying out of
//      their wallet balance or, if that is empty, the earnings they already
//      hold. Money moves in the SAME transaction as the request row, so a
//      creator can never be charged for a request that was not stored;
//   2. every admin is told, and an admin approves or rejects it. The badge goes
//      live on approval and not before — paying is not the same as being
//      granted;
//   3. it expires. `User.verifiedUntil` carries the date, and the badge comes
//      down on its own when the date passes, until the creator buys another
//      month.
//
// A rejection refunds the money to the exact source it came from. That is why
// `paymentMethod` is stored per request rather than inferred: refunding a wallet
// charge into creator earnings (or the reverse) puts the money in a place the
// creator never spent from.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { debitWallet } from "./balance.service";

/** TZS per month, from the one place the platform prices things. */
export const BLUE_TICK_PRICE = config.business.blueTickMonthlyPrice;

/** How many days one bought month lasts. */
export const BLUE_TICK_MONTH_DAYS = config.business.blueTickMonthDays;

/** How many months one request may cover. */
export const MAX_BLUE_TICK_MONTHS = 12;

/** Where a charge came from — and where a refund has to go back to. */
export type BlueTickSource = "WALLET" | "EARNINGS";

/**
 * The budget for an interactive transaction here.
 *
 * Prisma's default is 5 seconds, and that clock measures the DATABASE, not the
 * work: this transaction reads (creator, balance, any waiting request), debits,
 * and then writes four rows. On a networked Postgres behind a connection pooler
 * one round trip measures in the hundreds of milliseconds — measured on this
 * deployment: 2.6 s for a cold first query and ~0.5 s per query after it — so a
 * charge that is doing nothing wrong runs out of time and rolls back. The
 * rollback is correct; the creator just cannot buy anything, which is why the
 * budget is set to where the work actually fits.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * Is this account's badge live right now?
 *
 * `isVerified` alone is not the answer any more: a bought badge also has an
 * expiry, and the two facts live in different columns. Everything that decides
 * whether to DRAW a badge reads this, so a tick that ran out reads as gone even
 * if a sweep has not cleared the row yet.
 *
 * A null `verifiedUntil` means "no expiry" — an admin-granted badge, or one that
 * predates the column. It stays live.
 */
export function blueTickIsLive(user: {
  isVerified: boolean;
  verifiedUntil: Date | null;
}): boolean {
  if (!user.isVerified) return false;
  return user.verifiedUntil === null || user.verifiedUntil.getTime() > Date.now();
}

/** When a request for `months` months, approved now, would run out. */
export function blueTickExpiryFrom(from: Date, months: number): Date {
  return new Date(from.getTime() + months * BLUE_TICK_MONTH_DAYS * 86_400_000);
}

// ---------------------------------------------------------------------------
// The creator's own view
// ---------------------------------------------------------------------------

export interface BlueTickHistoryRow {
  id: string;
  status: string;
  amount: number;
  months: number;
  paymentMethod: string;
  paidAt: string;
  expiresAt: string | null;
  rejectionReason: string | null;
}

export interface BlueTickView {
  /** True when the badge should be showing right now. */
  live: boolean;
  /** When a live badge ends, or null for one that never expires. */
  expiresAt: string | null;
  /** TZS per month, so the screen never hardcodes the price. */
  price: number;
  monthDays: number;
  maxMonths: number;
  /** What the creator can pay from. */
  walletBalance: number;
  availableBalance: number;
  /** True when either source covers one month. */
  canAfford: boolean;
  /** A charge awaiting an admin decision, if any. */
  pending: BlueTickHistoryRow | null;
  history: BlueTickHistoryRow[];
}

/**
 * Everything the creator's blue-tick card needs, in one read.
 *
 * Expiry is reconciled first: opening the card is one of the moments the badge
 * has to be right, so a month that has run out is cleared here rather than
 * waiting for a sweep.
 */
export async function getBlueTickView(userId: string): Promise<BlueTickView> {
  await reconcileUserBlueTick(userId);

  const [user, balance, requests] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { isVerified: true, verifiedUntil: true, walletBalance: true },
    }),
    prisma.creatorBalance.findUnique({
      where: { creatorId: userId },
      select: { availableBalance: true },
    }),
    prisma.blueTickRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  const walletBalance = user?.walletBalance ?? 0;
  const availableBalance = balance?.availableBalance ?? 0;
  const history = requests.map(toHistoryRow);
  const pending = history.find((r) => r.status === "PAID") ?? null;

  return {
    live: user ? blueTickIsLive(user) : false,
    // A live badge with no expiry date is an admin-granted one; saying "never
    // expires" would be a promise the platform has not made, so it reports null.
    expiresAt: user?.verifiedUntil?.toISOString() ?? null,
    price: BLUE_TICK_PRICE,
    monthDays: BLUE_TICK_MONTH_DAYS,
    maxMonths: MAX_BLUE_TICK_MONTHS,
    walletBalance,
    availableBalance,
    canAfford:
      walletBalance >= BLUE_TICK_PRICE || availableBalance >= BLUE_TICK_PRICE,
    pending,
    history,
  };
}

function toHistoryRow(request: {
  id: string;
  status: string;
  amount: number;
  months: number;
  paymentMethod: string;
  paidAt: Date;
  expiresAt: Date | null;
  rejectionReason: string | null;
}): BlueTickHistoryRow {
  return {
    id: request.id,
    status: request.status,
    amount: request.amount,
    months: request.months,
    paymentMethod: request.paymentMethod,
    paidAt: request.paidAt.toISOString(),
    expiresAt: request.expiresAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
  };
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

export type BlueTickPurchaseResult =
  | {
      ok: true;
      requestId: string;
      amount: number;
      months: number;
      source: BlueTickSource;
      walletBalance: number;
      availableBalance: number;
    }
  | {
      ok: false;
      reason: "NOT_CREATOR" | "ALREADY_ACTIVE" | "AWAITING_REVIEW" | "INSUFFICIENT_FUNDS";
      walletBalance: number;
      availableBalance: number;
      needed: number;
    };

/**
 * Charge a creator for a blue tick and record the request for an admin.
 *
 * The debit, the request row and the ledger row are one transaction: a charged
 * creator always has something to point at, and a request row always has the
 * money that paid for it. Admins are notified in the same transaction, because
 * a request nobody is told about is invisible until someone goes looking.
 */
export async function requestBlueTick(params: {
  userId: string;
  months?: number;
}): Promise<BlueTickPurchaseResult> {
  const { userId } = params;
  const months = clampMonths(params.months);
  const amount = BLUE_TICK_PRICE * months;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        displayName: true,
        email: true,
        isVerified: true,
        verifiedUntil: true,
        walletBalance: true,
      },
    });

    if (!user || user.role !== "CREATOR") {
      return {
        ok: false as const,
        reason: "NOT_CREATOR" as const,
        walletBalance: user?.walletBalance ?? 0,
        availableBalance: 0,
        needed: amount,
      };
    }

    const balance = await tx.creatorBalance.findUnique({
      where: { creatorId: userId },
      select: { availableBalance: true },
    });
    const availableBalance = balance?.availableBalance ?? 0;

    // A live badge is not bought twice. The date is checked, not just the flag:
    // a tick whose month ran out is buyable again the moment it lapses.
    if (blueTickIsLive(user)) {
      return {
        ok: false as const,
        reason: "ALREADY_ACTIVE" as const,
        walletBalance: user.walletBalance,
        availableBalance,
        needed: amount,
      };
    }

    // One charge at a time. Two paid requests waiting for the same decision
    // would let an admin approve both and hand out two months for one tick.
    const waiting = await tx.blueTickRequest.findFirst({
      where: { userId, status: "PAID" },
      select: { id: true },
    });
    if (waiting) {
      return {
        ok: false as const,
        reason: "AWAITING_REVIEW" as const,
        walletBalance: user.walletBalance,
        availableBalance,
        needed: amount,
      };
    }

    // Wallet first, then earnings. Both debits are conditional updates, so a
    // concurrent spend cannot overdraw either source (see balance.service.ts).
    let source: BlueTickSource | null = null;
    let walletBalance = user.walletBalance;

    if (user.walletBalance >= amount) {
      const debited = await debitWallet(tx, { userId, amount });
      if (debited.ok) {
        source = "WALLET";
        walletBalance = debited.balance;
      }
    }

    if (!source && availableBalance >= amount) {
      const debited = await tx.creatorBalance.updateMany({
        where: { creatorId: userId, availableBalance: { gte: amount } },
        data: { availableBalance: { decrement: amount } },
      });
      if (debited.count === 1) source = "EARNINGS";
    }

    if (!source) {
      return {
        ok: false as const,
        reason: "INSUFFICIENT_FUNDS" as const,
        walletBalance,
        availableBalance,
        needed: amount,
      };
    }

    // The ledger row. `userId` is the creator (they paid) and there is no
    // creatorId credit: the platform is the seller here, not another creator.
    const ledger = await tx.transaction.create({
      data: {
        userId,
        amount,
        type: "BLUE_TICK",
        status: "SUCCESS",
        gateway: null,
        metadata: {
          method: source === "WALLET" ? "wallet" : "earnings",
          product: "blue_tick",
          months,
        },
      },
    });

    const request = await tx.blueTickRequest.create({
      data: {
        userId,
        amount,
        months,
        status: "PAID",
        paymentMethod: source,
        transactionId: ledger.id,
      },
    });

    await tx.notification.create({
      data: {
        userId,
        title: "Payment received — blue tick pending review ⏳",
        message: `We received TZS ${amount.toLocaleString()} for ${months} month${
          months > 1 ? "s" : ""
        } of the blue tick. An admin will approve it shortly; the badge appears the moment they do.`,
        type: "info",
        link: "/creator",
      },
    });

    // Tell every admin. A request that only exists in a table is a request that
    // waits until somebody happens to open the right tab.
    const admins = await tx.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((admin) => ({
          userId: admin.id,
          title: "Blue tick request 💠",
          message: `${user.displayName || user.email || "A creator"} paid TZS ${amount.toLocaleString()} for ${months} month${
            months > 1 ? "s" : ""
          } of the blue tick — approve it in Admin → Blue ticks.`,
          type: "info",
          link: "/admin",
        })),
      });
    }

    return {
      ok: true as const,
      requestId: request.id,
      amount,
      months,
      source,
      walletBalance,
      availableBalance:
        source === "EARNINGS" ? availableBalance - amount : availableBalance,
    };
  }, TX_OPTIONS);
}

function clampMonths(value: unknown): number {
  const months = Math.floor(Number(value));
  if (!Number.isFinite(months) || months < 1) return 1;
  return Math.min(MAX_BLUE_TICK_MONTHS, months);
}

// ---------------------------------------------------------------------------
// Admin decisions
// ---------------------------------------------------------------------------

export type BlueTickDecision =
  | {
      ok: true;
      requestId: string;
      userId: string;
      expiresAt: string | null;
      amount: number;
      refunded: boolean;
    }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_REVIEWED" };

/**
 * Approve a paid request: the badge goes live for the months bought, starting
 * now. Card and charge are one transaction, and the notice to the creator rides
 * along with them — a badge that appears without the creator knowing why is a
 * support ticket.
 */
export async function approveBlueTick(params: {
  requestId: string;
  adminId: string;
}): Promise<BlueTickDecision> {
  const { requestId, adminId } = params;

  return prisma.$transaction(async (tx) => {
    const request = await tx.blueTickRequest.findUnique({ where: { id: requestId } });
    if (!request) return { ok: false as const, reason: "NOT_FOUND" as const };
    if (request.status !== "PAID") {
      return { ok: false as const, reason: "ALREADY_REVIEWED" as const };
    }

    // The month starts when it is approved, not when it was paid: a request
    // that waited a day for an admin must not hand the creator a day less than
    // they bought, and a creator must never end up charged for time that has
    // already passed.
    const now = new Date();
    const expiresAt = blueTickExpiryFrom(now, request.months);

    await tx.blueTickRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        startsAt: now,
        expiresAt,
        reviewedBy: adminId,
        reviewedAt: now,
      },
    });

    await tx.user.update({
      where: { id: request.userId },
      data: { isVerified: true, verifiedUntil: expiresAt },
    });

    await tx.notification.create({
      data: {
        userId: request.userId,
        title: "Your blue tick is live 💠",
        message: `The verified badge is now shown on your profile until ${expiresAt.toLocaleDateString(
          "en-GB"
        )}.`,
        type: "success",
        link: "/creator",
      },
    });

    return {
      ok: true as const,
      requestId,
      userId: request.userId,
      expiresAt: expiresAt.toISOString(),
      amount: request.amount,
      refunded: false,
    };
  }, TX_OPTIONS);
}

/**
 * Reject a paid request and give the money back.
 *
 * The refund goes to the source the charge came from, in the same transaction
 * that closes the request, and the ledger row is marked REFUNDED so the money
 * trail reads the same way a refunded purchase does.
 */
export async function rejectBlueTick(params: {
  requestId: string;
  adminId: string;
  reason?: string;
}): Promise<BlueTickDecision> {
  const { requestId, adminId } = params;
  const reason = params.reason?.slice(0, 500) || "Not approved";

  return prisma.$transaction(async (tx) => {
    const request = await tx.blueTickRequest.findUnique({ where: { id: requestId } });
    if (!request) return { ok: false as const, reason: "NOT_FOUND" as const };
    if (request.status !== "PAID") {
      return { ok: false as const, reason: "ALREADY_REVIEWED" as const };
    }

    if (request.paymentMethod === "EARNINGS") {
      await tx.creatorBalance.upsert({
        where: { creatorId: request.userId },
        create: {
          creatorId: request.userId,
          availableBalance: request.amount,
          pendingBalance: 0,
          totalEarned: 0,
        },
        update: { availableBalance: { increment: request.amount } },
      });
    } else {
      await tx.user.update({
        where: { id: request.userId },
        data: { walletBalance: { increment: request.amount } },
      });
    }

    if (request.transactionId) {
      await tx.transaction.update({
        where: { id: request.transactionId },
        data: { status: "REFUNDED" },
      });
    }

    await tx.blueTickRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
    });

    await tx.notification.create({
      data: {
        userId: request.userId,
        title: "Blue tick request declined",
        message: `Your request was not approved: ${reason}. TZS ${request.amount.toLocaleString()} was returned to your ${
          request.paymentMethod === "EARNINGS" ? "earnings balance" : "wallet"
        }.`,
        type: "warning",
        link: "/creator",
      },
    });

    return {
      ok: true as const,
      requestId,
      userId: request.userId,
      expiresAt: null,
      amount: request.amount,
      refunded: true,
    };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Take the badge off ONE account whose month has run out.
 *
 * Cheap and idempotent: one conditional update that moves nothing unless the
 * date has actually passed, so it is safe to call on every read of a profile.
 * The admin-granted badge (verifiedUntil NULL) is untouched by design.
 */
export async function reconcileUserBlueTick(userId: string): Promise<boolean> {
  const now = new Date();
  const cleared = await prisma.user.updateMany({
    where: { id: userId, isVerified: true, verifiedUntil: { lt: now } },
    data: { isVerified: false, verifiedUntil: null },
  });

  if (cleared.count === 0) return false;

  await prisma.blueTickRequest.updateMany({
    where: { userId, status: "APPROVED", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });

  return true;
}

/**
 * The sweep: every badge whose month has ended, taken down in one pass.
 *
 * Called by the supervisor poke (the catch-all schedule), and bounded so a
 * backlog of expired badges cannot run for minutes inside a cron function.
 */
export async function expireDueBlueTicks(limit = 200): Promise<number> {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: { isVerified: true, verifiedUntil: { lt: now } },
    select: { id: true },
    take: limit,
  });

  if (due.length === 0) return 0;

  const ids = due.map((user) => user.id);

  await prisma.user.updateMany({
    where: { id: { in: ids } },
    data: { isVerified: false, verifiedUntil: null },
  });

  await prisma.blueTickRequest.updateMany({
    where: { userId: { in: ids }, status: "APPROVED", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });

  await prisma.notification.createMany({
    data: ids.map((userId) => ({
      userId,
      title: "Your blue tick has ended",
      message:
        "The month you paid for is over, so the verified badge is no longer on your profile. Buy another month to bring it back.",
      type: "info",
      link: "/creator",
    })),
  });

  return ids.length;
}

// ---------------------------------------------------------------------------
// Admin listing
// ---------------------------------------------------------------------------

export interface BlueTickAdminRow {
  id: string;
  status: string;
  amount: number;
  months: number;
  paymentMethod: string;
  paidAt: string;
  expiresAt: string | null;
  rejectionReason: string | null;
  creator: {
    id: string;
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
    isVerified: boolean;
    verifiedUntil: string | null;
  };
}

/** Requests awaiting a decision (PAID), newest first, plus recent decisions. */
export async function listBlueTickRequests(): Promise<{
  pending: BlueTickAdminRow[];
  recent: BlueTickAdminRow[];
}> {
  await expireDueBlueTicks();

  const [pending, recent] = await Promise.all([
    prisma.blueTickRequest.findMany({
      where: { status: "PAID" },
      orderBy: { paidAt: "asc" },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            isVerified: true,
            verifiedUntil: true,
          },
        },
      },
    }),
    prisma.blueTickRequest.findMany({
      where: { status: { in: ["APPROVED", "REJECTED", "EXPIRED"] } },
      orderBy: { reviewedAt: "desc" },
      take: 50,
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
            isVerified: true,
            verifiedUntil: true,
          },
        },
      },
    }),
  ]);

  return { pending: pending.map(toAdminRow), recent: recent.map(toAdminRow) };
}

function toAdminRow(request: {
  id: string;
  status: string;
  amount: number;
  months: number;
  paymentMethod: string;
  paidAt: Date;
  expiresAt: Date | null;
  rejectionReason: string | null;
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
    isVerified: boolean;
    verifiedUntil: Date | null;
  };
}): BlueTickAdminRow {
  return {
    id: request.id,
    status: request.status,
    amount: request.amount,
    months: request.months,
    paymentMethod: request.paymentMethod,
    paidAt: request.paidAt.toISOString(),
    expiresAt: request.expiresAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    creator: {
      id: request.user.id,
      displayName: request.user.displayName,
      email: request.user.email,
      avatarUrl: request.user.avatarUrl,
      isVerified: request.user.isVerified,
      verifiedUntil: request.user.verifiedUntil?.toISOString() ?? null,
    },
  };
}
