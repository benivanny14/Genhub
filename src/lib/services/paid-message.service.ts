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

/** The `metadata.method` value POST /api/messages stamps on its transaction. */
export const PAY_MESSAGE_METHOD = "pay_message";

export interface PaidMessageRow {
  id: string;
  amount: number;
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
  /** Lifetime value credited to this creator by those messages. */
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

  // One definition of "a paid message", so the lifetime total, the holding split
  // and the list below cannot disagree about which rows they are counting.
  const paidMessage = {
    creatorId,
    status: "SUCCESS" as const,
    creatorCut: { not: null },
    metadata: { path: ["method"], equals: PAY_MESSAGE_METHOD },
  };

  const [lifetime, held, oldestHeld, recent] = await Promise.all([
    prisma.transaction.aggregate({
      where: paidMessage,
      _count: { _all: true },
      _sum: { creatorCut: true },
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
        createdAt: m.createdAt.toISOString(),
        clearsAt: clearsAt.toISOString(),
        held: clearsAt.getTime() > Date.now(),
        sender: m.sender,
      };
    }),
  };
}
