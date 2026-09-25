// =============================================================================
// GENHUB - Validate Coupon API Route
// POST /api/coupons/validate - Preview a coupon before paying
//
// Unauthenticated by design (the paywall previews a code before anyone signs
// in), which makes it the one place where coupon codes can be TESTED without
// spending money. The response says clearly whether a code exists, so an
// unlimited endpoint is a code-enumeration oracle: guessing "SAVE10", "SAVE20"
// … eventually finds a live discount. Rate limited per IP at the auth ceiling,
// which is far more than a human typing a code needs.
// =============================================================================

import { NextRequest } from "next/server";
import { api } from "@/lib/api-response";
import { validateCouponSchema } from "@/lib/validation";
import { applyCoupon } from "@/lib/coupons";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const { allowed } = await checkRateLimit(
      `coupon:${clientIp(request.headers)}`,
      config.rateLimit.auth.max,
      config.rateLimit.auth.windowMs
    );
    if (!allowed) return api.rateLimited("Too many attempts — please wait a moment");

    const body = await request.json();
    const result = validateCouponSchema.safeParse(body);
    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { code, amount, context } = result.data;

    // Still open to signed-out visitors (the paywall previews a code before
    // anyone signs in), but when there IS a session the per-account rule is
    // applied here too — so a customer who already spent the coupon is told
    // while typing it, not after paying.
    const viewer = await getCurrentUser();
    const outcome = await applyCoupon({
      code,
      amount,
      context,
      userId: viewer?.userId,
    });

    if (!outcome.valid) {
      return api.error(outcome.error || "This coupon is not valid", 400, "INVALID_COUPON");
    }

    return api.success({
      discount: outcome.discount || 0,
      bonus: outcome.bonus || 0,
      finalAmount: outcome.finalAmount,
    });
  } catch (error) {
    console.error("[Validate Coupon Error]", error);
    return api.internal();
  }
}
