// =============================================================================
// GENHUB - Wallet daily spend allowance
// GET /api/wallet/spend-cap - how much the signed-in wallet may still spend
// before the rolling 24-hour cap (services/spend-cap.service.ts) refuses a
// charge.
//
// A cap the customer cannot see is a bug report waiting to happen: the moment it
// bites is the same moment they are trying to buy, and \"you have reached your
// limit\" arriving then reads as a broken wallet. The wallet page reads this on
// mount so the number is on screen before the refusal is. `data` is null when
// the cap is switched off, and the page hides the panel rather than show a
// figure it does not enforce.
// =============================================================================

import { NextRequest } from "next/server";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { spendAllowance } from "@/lib/services/spend-cap.service";

export async function GET(_request: NextRequest) {
  try {
    const auth = await requireAuth();

    const allowance = await spendAllowance(auth.userId);

    return api.success(allowance);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Wallet Spend Cap Error]", error);
    return api.internal();
  }
}
