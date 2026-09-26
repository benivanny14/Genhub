// =============================================================================
// GENHUB - Daily spend cap
//
// A per-transaction limit bounds ONE charge; it says nothing about a day of
// them. A stolen session (or a script) does not need one big purchase — it can
// drain a wallet through twenty small ones, each comfortably under every
// per-item ceiling. This is the ceiling on the total.
//
// -----------------------------------------------------------------------------
// What counts as spending
//
// A rolling 24-hour window over the ledger, counting only SUCCESS rows of the
// types that take money OUT of a wallet:
//
//   PPV_PURCHASE, SUBSCRIPTION, TIP (tips and paid messages), BLUE_TICK
//
// Incoming money — a WALLET_TOPUP, a REFERRAL_BONUS — is deliberately NOT
// counted. Counting it would mean that topping up to buy something would spend
// the very budget the cap is protecting, and a customer could be refused for
// having added funds.
//
// Rolling, not calendar: a daily reset at midnight is a cliff an abuser simply
// waits out, and it would also make the cap behave differently depending on the
// server's timezone.
// =============================================================================

import prisma from "../db";
import config from "../config";

/** 24 hours, measured in milliseconds. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The ledger types that count as SPENDING.
 *
 * `TIP` covers both a tip and a paid message — POST /api/messages writes the
 * same transaction type with `metadata.method = "pay_message"`, which is why
 * they share one ceiling rather than getting two.
 */
export const SPEND_TYPES = [
  "PPV_PURCHASE",
  "SUBSCRIPTION",
  "TIP",
  "BLUE_TICK",
] as const;

export interface SpendCapState {
  /** True when `amount` still fits under the cap. */
  allowed: boolean;
  /** The configured cap, or 0 when the cap is disabled. */
  cap: number;
  /** Already spent inside the rolling window. */
  spent: number;
  /** How much more may be spent right now. `Infinity` when disabled. */
  remaining: number;
  /** How far past the cap this charge would go; 0 when allowed. */
  overBy: number;
}

/**
 * What this account has spent from its wallet in the last 24 hours.
 *
 * One indexed aggregate. `now` is injectable so the window can be tested
 * without waiting a day.
 */
export async function dailySpend(
  userId: string,
  now: number = Date.now()
): Promise<number> {
  const total = await prisma.transaction.aggregate({
    where: {
      userId,
      status: "SUCCESS",
      type: { in: [...SPEND_TYPES] },
      createdAt: { gte: new Date(now - SPEND_WINDOW_MS) },
    },
    _sum: { amount: true },
  });
  return total._sum.amount ?? 0;
}

/**
 * Whether one more charge of `amount` fits under this account's daily cap.
 *
 * A cap of 0 (or less) means the limit is switched off, and the caller is told
 * so rather than being handed a fake allowance. This is a READ, not a
 * reservation: two charges starting in the same instant can both pass. That is
 * the right trade here — the cap exists to stop a runaway, and a hard lock
 * would put the cost of the whole endpoint on a check that a legitimate shopper
 * would only ever feel as a false refusal.
 */
export async function checkSpendCap(
  userId: string,
  amount: number,
  now: number = Date.now()
): Promise<SpendCapState> {
  const cap = config.business.dailySpendCap;
  if (cap <= 0) {
    return { allowed: true, cap: 0, spent: 0, remaining: Infinity, overBy: 0 };
  }

  const spent = await dailySpend(userId, now);
  const remaining = Math.max(0, cap - spent);
  const allowed = amount <= remaining;

  return {
    allowed,
    cap,
    spent,
    remaining,
    overBy: allowed ? 0 : amount - remaining,
  };
}

/**
 * The sentence a refused charge shows the customer.
 *
 * It names both numbers, because "you have reached your limit" with no figures
 * is what makes someone try the same amount again — the same reason the wallet
 * refusal elsewhere names the balance.
 */
export function spendCapMessage(state: SpendCapState): string {
  return (
    `Daily spend limit reached — you have spent TZS ${state.spent.toLocaleString()} ` +
    `of TZS ${state.cap.toLocaleString()} in the last 24 hours. ` +
    "This limit protects your wallet and resets as older charges fall outside the 24-hour window."
  );
}
