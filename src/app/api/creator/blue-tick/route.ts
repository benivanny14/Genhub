// =============================================================================
// GENHUB - Creator: buy the blue tick
// GET  /api/creator/blue-tick  - price, balances, current badge, history
// POST /api/creator/blue-tick  - pay for { months } (default 1)
//
// The charge happens here, in full, before any admin sees the request — the
// creator pays first, the admin confirms — which is why a rejection has a real
// refund path (services/blue-tick.service.ts) instead of a promise to bill or
// not bill later.
//
// creator-only on purpose. A viewer's badge would be a different product, and
// nothing about this one — earnings being an accepted payment source — makes
// sense for an account that has no earnings.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  getBlueTickView,
  requestBlueTick,
  BLUE_TICK_PRICE,
} from "@/lib/services/blue-tick.service";

export async function GET(_request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");
    const view = await getBlueTickView(auth.userId);
    return api.success(view);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Blue Tick Read Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // The body is optional: one month is what almost every purchase is, and a
    // request with no body at all should mean the obvious thing rather than a
    // parse error.
    const body = await request.json().catch(() => ({}));
    const months = Number(body?.months) || 1;

    const result = await requestBlueTick({ userId: auth.userId, months });

    if (!result.ok) {
      switch (result.reason) {
        case "NOT_CREATOR":
          return api.forbidden("Only creators can buy the blue tick");
        case "ALREADY_ACTIVE":
          return api.error("Your blue tick is already active");
        case "AWAITING_REVIEW":
          return api.error(
            "You already have a blue tick payment waiting for admin approval"
          );
        default:
          return api.error(
            `You need TZS ${BLUE_TICK_PRICE.toLocaleString()} to buy a month. ` +
              `Wallet: TZS ${result.walletBalance.toLocaleString()} · ` +
              `earnings: TZS ${result.availableBalance.toLocaleString()}.`
          );
      }
    }

    const paidFrom =
      result.source === "EARNINGS" ? "your earnings balance" : "your wallet";

    return api.success(
      {
        requestId: result.requestId,
        amount: result.amount,
        months: result.months,
        source: result.source,
      },
      `Payment received from ${paidFrom} — an admin will approve your blue tick shortly`,
      201
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Blue Tick Purchase Error]", error);
    return api.internal();
  }
}
