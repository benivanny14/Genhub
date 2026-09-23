// =============================================================================
// GENHUB - Coupon engine
// Shared by /api/coupons/validate, purchase, and top-up routes.
// PERCENT → % off purchases / % bonus on top-ups
// FIXED   → flat TZS off purchases / flat TZS bonus on top-ups
// =============================================================================

import prisma from "@/lib/db";

export interface CouponOutcome {
  valid: boolean;
  error?: string;
  couponId?: string;
  discount?: number; // TZS removed from a purchase
  bonus?: number; // TZS added on a top-up
  finalAmount?: number; // what the payer actually pays / receives
}

export async function applyCoupon(opts: {
  code?: string | null;
  amount: number; // purchase price, or top-up amount
  context: "purchase" | "topup";
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

// Record a successful use (called after payment initiation succeeds)
export async function markCouponUsed(couponId: string): Promise<void> {
  try {
    await prisma.coupon.update({
      where: { id: couponId },
      data: { usedCount: { increment: 1 } },
    });
  } catch {
    // non-critical
  }
}
