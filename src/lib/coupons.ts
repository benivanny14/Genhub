// =============================================================================
// GENHUB - Coupon engine
//
// Shared by /api/coupons/validate, purchase, and top-up routes.
// PERCENT -> % off purchases / % bonus on top-ups
// FIXED   -> flat TZS off purchases / flat TZS bonus on top-ups
//
// -----------------------------------------------------------------------------
// Two things this file used to get wrong, and both cost money
// -----------------------------------------------------------------------------
// 1. THE LIMIT WAS DECIDED IN JAVASCRIPT.
//    `usedCount >= maxUses` was a read, and the increment came later, so two
//    checkouts arriving together both read the old count and both passed. A
//    coupon limited to one use could be spent any number of times, and the
//    column said so afterwards — `usedCount` ended up past `maxUses` and nothing
//    noticed. The limit is now part of the write: one conditional UPDATE whose
//    WHERE clause contains the rule, inside the same transaction that records
//    who redeemed it.
//
// 2. IT WAS CONSUMED AT CHECKOUT, NOT AT SETTLEMENT.
//    The counter moved the moment a USSD prompt was requested, so a customer who
//    never approved the prompt — the common outcome — burned a limited coupon
//    without buying anything. Consumption now happens where the money actually
//    lands (the shared payment webhook, and the wallet path right after its
//    atomic debit), which is the only moment that can honestly say "this coupon
//    was used".
//
// -----------------------------------------------------------------------------
// Why there is a redemption row
// -----------------------------------------------------------------------------
// `maxUses` is a global budget; nothing stopped one account from spending the
// whole of it. CouponRedemption makes "this user has had this coupon" a fact the
// database enforces, so the global budget and the per-account rule are two
// separate constraints that both hold. Before it, a coupon created with no
// `maxUses` was unlimited per person as well as in total.
// =============================================================================

import prisma from "@/lib/db";
import { Prisma } from "@prisma/client";

export interface CouponOutcome {
  valid: boolean;
  error?: string;
  couponId?: string;
  discount?: number; // TZS removed from a purchase
  bonus?: number; // TZS added on a top-up
  finalAmount?: number; // what the payer actually pays / receives
}

/** The outcome of recording a redemption. Never throws; callers decide. */
export type CouponConsumeResult =
  | "OK"
  | "ALREADY_USED"
  | "EXHAUSTED"
  | "NOT_FOUND"
  | "ERROR";

/**
 * Validate a coupon for this user, without consuming it.
 *
 * `userId` is optional so /api/coupons/validate can preview a code for a
 * signed-out visitor; when it is present the per-account rule is applied, so a
 * customer who has already used the coupon is told before they reach checkout
 * rather than after they pay.
 */
export async function applyCoupon(opts: {
  code?: string | null;
  amount: number;
  context: "purchase" | "topup";
  userId?: string;
}): Promise<CouponOutcome> {
  const raw = opts.code?.trim().toUpperCase();
  if (!raw) return { valid: false };

  const coupon = await prisma.coupon.findUnique({ where: { code: raw } });

  if (!coupon || !coupon.isActive) {
    return { valid: false, error: "This coupon is not valid" };
  }
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    return { valid: false, error: "This coupon has expired" };
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, error: "This coupon has been fully redeemed" };
  }

  if (opts.userId) {
    const alreadyUsed = await prisma.couponRedemption.findUnique({
      where: { couponId_userId: { couponId: coupon.id, userId: opts.userId } },
      select: { id: true },
    });
    if (alreadyUsed) {
      return { valid: false, error: "You have already used this coupon" };
    }
  }

  const isPercent = coupon.type === "PERCENT";
  const value = coupon.value;

  if (opts.context === "purchase") {
    const discount = isPercent
      ? Math.floor((opts.amount * value) / 100)
      : Math.min(value, opts.amount);
    const finalAmount = Math.max(0, opts.amount - discount);
    return { valid: true, couponId: coupon.id, discount, finalAmount };
  }

  // top-up: coupon adds a bonus to the credited wallet amount
  const bonus = isPercent
    ? Math.floor((opts.amount * value) / 100)
    : value;
  return {
    valid: true,
    couponId: coupon.id,
    bonus,
    finalAmount: opts.amount + bonus,
  };
}

/**
 * Record that this user has now spent this coupon, atomically.
 *
 * Called from the settlement paths only — see the file header. The global budget
 * and the per-account rule are enforced by the database in one transaction, so
 * two settlements racing each other cannot both win.
 *
 * `ERROR` (the database refused us) is deliberately distinct from `EXHAUSTED`:
 * a settlement that is already paid for must not be described as unauthorised,
 * and the caller logs it and moves on rather than failing a completed payment.
 */
export async function consumeCoupon(params: {
  couponId: string;
  userId: string;
  transactionId?: string | null;
}): Promise<CouponConsumeResult> {
  const { couponId, userId, transactionId } = params;

  try {
    return await prisma.$transaction(async (tx) => {
      const already = await tx.couponRedemption.findUnique({
        where: { couponId_userId: { couponId, userId } },
        select: { id: true },
      });
      if (already) return "ALREADY_USED";

      // The rule is in the WHERE clause, so it cannot be decided by a read that
      // went stale between the check and the write.
      const claimed = await tx.$executeRaw`
        UPDATE "Coupon"
           SET "usedCount" = "usedCount" + 1
         WHERE "id" = ${couponId}
           AND "isActive" = true
           AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
      `;
      if (claimed === 0) return "EXHAUSTED";

      await tx.couponRedemption.create({
        data: { couponId, userId, transactionId: transactionId ?? null },
      });

      return "OK";
    });
  } catch (error) {
    // A unique-constraint failure here is the two-requests-arriving-together
    // case: the transaction rolls back, so nothing was counted twice.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return "ALREADY_USED";
    }
    console.error("[Coupon] Could not record the redemption", error);
    return "ERROR";
  }
}
