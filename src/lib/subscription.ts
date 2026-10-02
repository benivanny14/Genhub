// =============================================================================
// GENHUB - What a profile subscription costs
//
// TZS 8,000 a month. One constant, because the number was written out in three
// places — the subscribe API, the creator profile page and the creators list —
// and every one of them said 5,000 by hand.
//
// This is a DEFAULT, not an override. `CreatorProfile.subscriptionPrice` still
// wins when a creator has a price of their own (the revenue-split and
// holding-release suites set one and depend on the ledger agreeing with it), and
// the schema default is the same number as this constant so a profile created
// without a price and a profile created with one cannot disagree.
//
// What a price change does NOT do: re-charge an existing subscriber. Renewals
// run at `sub.price` — the amount that subscriber actually agreed to — in
// subscription-renewal.service.ts, so raising this affects new subscriptions
// only. Keep that property if the price is ever raised again.
// =============================================================================

export const SUBSCRIPTION_PRICE_TZS = 8_000;

// =============================================================================
// Subscription periods
//
// A fan could only buy one calendar month. That leaves out the two ways people
// actually pay for a membership: a small weekly amount someone living week to
// week can afford, and a three-month block a committed fan would rather buy
// once. All three share one price base — the creator's monthly price — so a
// creator raising their price moves every plan together and none can be
// forgotten.
//
// `days` and `months` are mutually exclusive on purpose: a week is 7 days, not
// "0.23 months", because `setMonth` would drift across February. A month stays
// a month so an expiry keeps landing on the same day of the month.
// =============================================================================

export interface SubscriptionPlan {
  id: string;
  /** What the picker shows. */
  label: string;
  /** Period in days, when the plan is day-based. */
  days: number;
  /** Period in calendar months, when the plan is month-based. */
  months: number;
}

export const SUBSCRIPTION_PLANS: Record<string, SubscriptionPlan> = {
  weekly: { id: "weekly", label: "Weekly", days: 7, months: 0 },
  monthly: { id: "monthly", label: "Monthly", days: 0, months: 1 },
  quarterly: { id: "quarterly", label: "3 months", days: 0, months: 3 },
};

export const DEFAULT_SUBSCRIPTION_PLAN = "monthly";

/** The plan a caller means, falling back to monthly for anything unknown. */
export function resolveSubscriptionPlan(id: string | null | undefined): SubscriptionPlan {
  return SUBSCRIPTION_PLANS[id ?? ""] ?? SUBSCRIPTION_PLANS[DEFAULT_SUBSCRIPTION_PLAN];
}

/**
 * What a plan costs, from the creator's monthly base price.
 *
 * Weekly is a quarter of a month, rounded to whole TZS; quarterly is 2.5 months
 * for a month's worth of saving (buy three, pay for two and a half). The result
 * is floored at TZS 100 so a plan price can never fall under the smallest amount
 * the gateway will collect.
 */
export function planPrice(baseMonthlyPrice: number, planId: string): number {
  const plan = resolveSubscriptionPlan(planId);
  if (plan.id === "weekly") return Math.max(100, Math.round(baseMonthlyPrice / 4));
  if (plan.id === "quarterly") return Math.max(100, Math.round(baseMonthlyPrice * 2.5));
  return Math.max(100, baseMonthlyPrice);
}
