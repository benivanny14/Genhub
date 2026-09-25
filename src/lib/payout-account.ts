// =============================================================================
// GENHUB - The payout account a creator has used before
//
// Withdrawals are the one screen where the creator and the platform exchange
// money in the other direction, and every platform they have used before works
// the same way: you register where the money should go ONCE, then you ask for it.
//
// What this file does about that is deliberately small. The account details live
// on the payout request itself (`PayoutRequest.accountDetails`, `bankName`,
// `paymentMethod`) — that row is already the record of where money was sent, and
// a second copy of it on the user would be a second thing that can be out of
// date. So instead of a settings screen, the request form is pre-filled from the
// creator's own most recent request: they type it once, and every withdrawal
// after that is one number and a button.
//
// Only the READ of that history is here, pure and tested, because the rules are
// not obvious:
//
//   * the list arrives newest-first from the API, so "the first usable row" is
//     the right answer rather than the last;
//   * a row that cannot be paid to is not an account — an old, blank or
//     unknown-method row must be skipped rather than pre-fill a form that the
//     schema will then reject;
//   * a bank payout without a bank name is not a usable bank payout, because the
//     payer needs to know which bank to send it to.
//
// The label map lives here too, so the dashboard, the history list and the admin
// queue cannot drift into calling the same method three different things.
// =============================================================================

export const PAYOUT_METHODS = ["MPESA", "TIGO_PESA", "AIRTEL_MONEY", "BANK_TRANSFER"] as const;

export type PayoutMethodId = (typeof PAYOUT_METHODS)[number];

/** How a payout method reads to a person. The ids are what the API stores. */
export const PAYOUT_METHOD_LABEL: Record<string, string> = {
  MPESA: "M-Pesa",
  TIGO_PESA: "Tigo Pesa",
  AIRTEL_MONEY: "Airtel Money",
  BANK_TRANSFER: "Bank transfer",
};

/** A bank payout needs a bank name as well as an account number. */
export function isBankPayout(method: string): boolean {
  return method === "BANK_TRANSFER";
}

/** One row of payout history, as the balance endpoint returns it. */
export interface PayoutHistoryRow {
  paymentMethod: string;
  accountDetails: string;
  bankName?: string | null;
}

export function isValidPayoutMethod(method: string): method is PayoutMethodId {
  return (PAYOUT_METHODS as readonly string[]).includes(method);
}

/**
 * Where this creator's money last went, or null when they have never been paid.
 *
 * @param payouts newest-first, as `/api/creator/balance` returns them.
 */
export function lastPayoutAccount(
  payouts: PayoutHistoryRow[] | null | undefined
): PayoutHistoryRow | null {
  if (!payouts || payouts.length === 0) return null;

  for (const payout of payouts) {
    if (!isValidPayoutMethod(payout.paymentMethod)) continue;
    if (!payout.accountDetails || payout.accountDetails.trim().length < 5) continue;
    if (isBankPayout(payout.paymentMethod) && !payout.bankName) continue;
    return payout;
  }

  return null;
}

/**
 * One line naming where the money goes, for the confirmation the creator reads
 * before submitting — "M-Pesa · 0682642219", or "Bank transfer · CRDB · 0123…".
 */
export function describePayoutAccount(account: PayoutHistoryRow): string {
  const label = PAYOUT_METHOD_LABEL[account.paymentMethod] || account.paymentMethod;
  const parts = [label];
  if (isBankPayout(account.paymentMethod) && account.bankName) parts.push(account.bankName);
  parts.push(account.accountDetails);
  return parts.join(" · ");
}
