// =============================================================================
// GENHUB - Paid-message earnings
//
// Every direct message is paid, so a creator's inbox is a revenue line — and the
// money is theirs the moment it settles: a paid message is credited straight to
// the creator's available balance, with no holding period.
//
// The figures are read from the same ledger every other earnings card reads:
// SUCCESS transactions carrying a `creatorCut`. A TIP is not a message unless
// its metadata says so — /api/tips writes the same transaction type for a plain
// tip — hence the JSON-path filter.
// =============================================================================

import prisma from "../db";
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
  /** When this message's money became withdrawable — i.e. when it settled. */
  clearsAt: string;
  /** Always false now: nothing is held. Kept so the payload shape is stable. */
  held: boolean;
  sender: {
    id: string;
    /** Public handle, preferred over `displayName` wherever it exists. */
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface PaidMessageEarnings {
  /** Lifetime count of paid messages received. */
  messages: number;
  /** What fans paid for those messages, before the platform's share. */
  gross: number;
  /** Lifetime value credited to this creator by those messages (their 70%). */
  earned: number;
  /** Always 0 now: nothing is held. Kept so the payload shape is stable. */
  heldMessages: number;
  /** Always 0 now: nothing is held. Kept so the payload shape is stable. */
  held: number;
  /** All of `earned` — it is withdrawable as soon as it lands. */
  cleared: number;
  /** Always null now: nothing is waiting to clear. */
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
  const paidMessage = { ...PAID_MESSAGE_LEDGER, creatorId };

  const [lifetime, recent] = await Promise.all([
    prisma.transaction.aggregate({
      where: paidMessage,
      _count: { _all: true },
      // `amount` is what the fan paid; `creatorCut` is this creator's share of it.
      _sum: { creatorCut: true, amount: true },
    }),
    prisma.payMessage.findMany({
      where: { receiverId: creatorId, amount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        amount: true,
        createdAt: true,
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    }),
  ]);

  const earned = lifetime._sum.creatorCut ?? 0;

  return {
    messages: lifetime._count._all,
    gross: lifetime._sum.amount ?? 0,
    earned,
    // Nothing is held any more: a paid message is withdrawable the moment it
    // settles, so every figure below reports "all of it, right now". The fields
    // stay — the dashboard and the tests keep one shape — but they no longer
    // describe a wait, because there is not one.
    heldMessages: 0,
    held: 0,
    cleared: earned,
    nextReleaseAt: null,
    recent: recent.map((m) => ({
      id: m.id,
      amount: m.amount,
      // The row shows two numbers — what the fan paid and what this creator
      // got — and they have to be the same halves the ledger wrote, so the
      // split is computed by the one function that owns it.
      earned: splitRevenue(m.amount).creatorCut,
      createdAt: m.createdAt.toISOString(),
      clearsAt: m.createdAt.toISOString(),
      held: false,
      sender: m.sender,
    })),
  };
}

/** How many creators the admin card lists before it says "and N more". */
export const CHAT_REVENUE_LIMIT = 20;

export interface ChatRevenueRow {
  creatorId: string;
  /** Public handle, preferred over `displayName` wherever it exists. */
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Lifetime paid messages received. */
  messages: number;
  /** Lifetime value of those messages. */
  earned: number;
  /** Always 0 now: nothing is held. Kept so the payload shape is stable. */
  heldMessages: number;
  /** Always 0 now: nothing is held. Kept so the payload shape is stable. */
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
 * `held` is reported as zero: nothing is held any more, and the admin card must
 * agree with the creator card about that (see getPaidMessageEarnings).
 */
export async function getChatRevenue(
  limit: number = CHAT_REVENUE_LIMIT
): Promise<ChatRevenue> {
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

  const [totals, users] = await Promise.all([
    prisma.transaction.aggregate({
      where: filter,
      // All three, because the platform's cut on chat is a number the admin card
      // shows rather than something left to be inferred from the other two.
      _sum: { creatorCut: true, amount: true, platformFee: true },
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    }),
  ]);

  const usersById = new Map(users.map((u) => [u.id, u]));

  return {
    totals: {
      creators: ranked.length,
      messages: totals._count._all,
      gross: totals._sum.amount ?? 0,
      earned: totals._sum.creatorCut ?? 0,
      platformFee: totals._sum.platformFee ?? 0,
      // Nothing is held any more — see getPaidMessageEarnings.
      heldMessages: 0,
      held: 0,
    },
    creators: listed.map((row) => {
      const creatorId = row.creatorId as string;
      return {
        creatorId,
        username: usersById.get(creatorId)?.username ?? null,
        displayName: usersById.get(creatorId)?.displayName ?? null,
        avatarUrl: usersById.get(creatorId)?.avatarUrl ?? null,
        messages: row._count._all,
        earned: row._sum.creatorCut ?? 0,
        heldMessages: 0,
        held: 0,
      };
    }),
    truncated: ranked.length > limit,
  };
}
