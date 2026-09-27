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
