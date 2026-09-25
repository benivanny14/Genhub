// =============================================================================
// GENHUB - Paid-message earnings
//
// Every direct message is paid, so a creator's inbox is a revenue line — and one
// that clears on a schedule of its own: the amount lands in `pendingBalance` and
// matures after the same 14-day holding period a video purchase does.
//
// The figures are read from the ledger the release job reads
// (src/lib/services/earning-release.service.ts), so this card can never promise
// money the holding job will not move: SUCCESS transactions carrying a
// `creatorCut`. A TIP is not a message unless its metadata says so — /api/tips
// writes the same transaction type for a plain tip — hence the JSON-path filter.
// =============================================================================

import prisma from "../db";
import config from "../config";
import { splitRevenue } from "./balance.service";

/** The `metadata.method` value POST /api/messages stamps on its transaction. */
export const PAY_MESSAGE_METHOD = "pay_message";

/**
 * One definition of "a paid message", shared by every read in this file.
 *
 * All three clauses matter. SUCCESS excludes a charge that failed or was
 * refunded; `creatorCut` excludes a message paid to an ordinary account, whose
 * money never entered a creator balance; and the metadata path keeps plain tips
 * out — /api/tips writes the same TIP transaction type.
 */
const PAID_MESSAGE_LEDGER = {
  status: "SUCCESS" as const,
  creatorCut: { not: null },
  metadata: { path: ["method"], equals: PAY_MESSAGE_METHOD },
};

export interface PaidMessageRow {
  id: string;
  /** What the fan paid, before the platform's share. */
  amount: number;
  /** This creator's share of that message (70%). */
  earned: number;
  createdAt: string;
  /** When this message's money leaves the 14-day holding. */
  clearsAt: string;
  /** True while the money is still inside the holding period. */
  held: boolean;
  sender: { id: string; displayName: string | null; avatarUrl: string | null };
}

export interface PaidMessageEarnings {
  /** Lifetime count of paid messages received. */
  messages: number;
  /** What fans paid for those messages, before the platform's share. */
  gross: number;
  /** Lifetime value credited to this creator by those messages (their 70%). */
  earned: number;
  /** How many received messages are still inside the holding period. */
  heldMessages: number;
  /** The part of `earned` still inside the 14-day holding. */
  held: number;
  /** The part of `earned` that has cleared the holding. */
  cleared: number;
  /** When the oldest held message matures, or null when nothing is held. */
  nextReleaseAt: string | null;
  /** The five most recent paid messages, newest first. */
  recent: PaidMessageRow[];
}

/**
 * What this creator has been paid for being messaged, and how much of it is
 * still inside the holding period.
 *
 * Read-only, and deliberately cheap: four indexed queries, no writes. The
 * release job is the thing that moves money; this only reports where it is.
 */
export async function getPaidMessageEarnings(
  creatorId: string
): Promise<PaidMessageEarnings> {
  const holdingMs = config.business.holdingPeriodDays * 86_400_000;
  const cutoff = new Date(Date.now() - holdingMs);

  const paidMessage = { ...PAID_MESSAGE_LEDGER, creatorId };

  const [lifetime, held, oldestHeld, recent] = await Promise.all([
    prisma.transaction.aggregate({
      where: paidMessage,
      _count: { _all: true },
      // `amount` is what the fan paid; `creatorCut` is this creator's share of it.
      _sum: { creatorCut: true, amount: true },
    }),
    prisma.transaction.aggregate({
      where: { ...paidMessage, createdAt: { gt: cutoff } },
      _count: { _all: true },
      _sum: { creatorCut: true },
    }),
    // The oldest still-held message matures first, so it is the date this
    // creator's next release actually lands on.
    prisma.transaction.findFirst({
      where: { ...paidMessage, createdAt: { gt: cutoff } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.payMessage.findMany({
      where: { receiverId: creatorId, amount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        amount: true,
        createdAt: true,
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    }),
  ]);

  const earned = lifetime._sum.creatorCut ?? 0;
  const heldAmount = held._sum.creatorCut ?? 0;

  return {
    messages: lifetime._count._all,
    gross: lifetime._sum.amount ?? 0,
    earned,
    heldMessages: held._count._all,
    held: heldAmount,
    // earned = held + cleared, by definition of the cutoff above.
    cleared: Math.max(0, earned - heldAmount),
    nextReleaseAt: oldestHeld
      ? new Date(oldestHeld.createdAt.getTime() + holdingMs).toISOString()
      : null,
    recent: recent.map((m) => {
      const clearsAt = new Date(m.createdAt.getTime() + holdingMs);
      return {
        id: m.id,
        amount: m.amount,
        // The row shows two numbers — what the fan paid and what this creator
        // got — and they have to be the same halves the ledger wrote, so the
        // split is computed by the one function that owns it.
        earned: splitRevenue(m.amount).creatorCut,
        createdAt: m.createdAt.toISOString(),
        clearsAt: clearsAt.toISOString(),
        held: clearsAt.getTime() > Date.now(),
        sender: m.sender,
      };
    }),
  };
}

/** How many creators the admin card lists before it says "and N more". */
export const CHAT_REVENUE_LIMIT = 20;

export interface ChatRevenueRow {
  creatorId: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Lifetime paid messages received. */
  messages: number;
  /** Lifetime value of those messages. */
  earned: number;
  /** How many of them are still inside the holding period. */
  heldMessages: number;
  /** The part of `earned` still inside the 14-day holding. */
  held: number;
}

export interface ChatRevenue {
  totals: {
    /** Creators paid at least once for a message — not every creator on the site. */
    creators: number;
    messages: number;
    /** What fans paid in total, before the split. */
    gross: number;
    /** The creators' 70%. */
    earned: number;
    /** The platform's 30%. */
    platformFee: number;
    heldMessages: number;
    held: number;
  };
  /** Highest earning first, at most `limit` of them. */
  creators: ChatRevenueRow[];
  /** True when `creators` is a prefix of the full list, so the card can say so. */
  truncated: boolean;
}

/**
 * Platform-wide chat revenue, broken down per creator.
 *
 * Read-only. The read is complete rather than paged — one row per creator who has
 * ever been paid for a message, which is the only way "N creators" above the list
 * can be a fact instead of an estimate — and the LIST is capped, so a small screen
 * does not have to render every creator. The totals come from separate aggregate
 * queries over the whole ledger, so the cap can never change them.
 *
 * `held` is the same 14-day window `getPaidMessageEarnings` uses — the release
 * job and both cards have to agree about what is still held.
 */
export async function getChatRevenue(
  limit: number = CHAT_REVENUE_LIMIT
): Promise<ChatRevenue> {
  const holdingMs = config.business.holdingPeriodDays * 86_400_000;
  const cutoff = new Date(Date.now() - holdingMs);
  // Messages to an ordinary account credit a wallet, not a creator balance, so
  // they are not creator revenue and carry no `creatorId` on the ledger row.
  const filter = { ...PAID_MESSAGE_LEDGER, creatorId: { not: null } };

  const perCreator = await prisma.transaction.groupBy({
    by: ["creatorId"],
    where: filter,
    _sum: { creatorCut: true },
    _count: { _all: true },
  });

  if (perCreator.length === 0) {
    return {
      totals: {
        creators: 0,
        messages: 0,
        gross: 0,
        earned: 0,
        platformFee: 0,
        heldMessages: 0,
        held: 0,
      },
      creators: [],
      truncated: false,
    };
  }

  // Ranked here rather than in the query: `take` before the sort would make the
  // "top N" depend on whatever order the database happened to return.
  const ranked = [...perCreator].sort(
    (a, b) => (b._sum.creatorCut ?? 0) - (a._sum.creatorCut ?? 0)
  );
  const listed = ranked.slice(0, limit);
  const ids = listed.map((row) => row.creatorId as string);

  const [held, totals, totalsHeld, users] = await Promise.all([
    // Only the displayed creators: the held split is a property of the rows being
    // shown, and the platform-wide split has its own query below.
    prisma.transaction.groupBy({
      by: ["creatorId"],
      where: { ...filter, creatorId: { in: ids }, createdAt: { gt: cutoff } },
      _sum: { creatorCut: true },
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: filter,
      // All three, because the platform's cut on chat is a number the admin card
      // shows rather than something left to be inferred from the other two.
      _sum: { creatorCut: true, amount: true, platformFee: true },
      _count: { _all: true },
    }),
    prisma.transaction.aggregate({
      where: { ...filter, createdAt: { gt: cutoff } },
      _sum: { creatorCut: true },
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, avatarUrl: true },
    }),
  ]);

  const heldByCreator = new Map(held.map((row) => [row.creatorId as string, row]));
  const usersById = new Map(users.map((u) => [u.id, u]));

  return {
    totals: {
      creators: ranked.length,
      messages: totals._count._all,
      gross: totals._sum.amount ?? 0,
      earned: totals._sum.creatorCut ?? 0,
      platformFee: totals._sum.platformFee ?? 0,
      heldMessages: totalsHeld._count._all,
      held: totalsHeld._sum.creatorCut ?? 0,
    },
    creators: listed.map((row) => {
      const creatorId = row.creatorId as string;
      const heldRow = heldByCreator.get(creatorId);
      return {
        creatorId,
        displayName: usersById.get(creatorId)?.displayName ?? null,
        avatarUrl: usersById.get(creatorId)?.avatarUrl ?? null,
        messages: row._count._all,
        earned: row._sum.creatorCut ?? 0,
        heldMessages: heldRow?._count._all ?? 0,
        held: heldRow?._sum.creatorCut ?? 0,
      };
    }),
    truncated: ranked.length > limit,
  };
}
