// =============================================================================
// GENHUB - What a withdrawal waiting in the queue needs next
//
// A payout request is the one row where a person is watching their phone, and
// the queue has three states an admin has to tell apart at a glance:
//
//   1. nobody has decided yet (PENDING);
//   2. approved and NOT sent — which, for an amount under the gateway's floor,
//      is the only way it can ever be sent, by hand;
//   3. sent to the gateway and not yet confirmed — where the only honest advice
//      is to wait, because re-sending money that is already in flight pays the
//      creator twice.
//
// All three look identical in a list of amounts. So the age and the next action
// are derived here, once, from the row itself — and the screen does not have to
// re-implement the rule (and cannot get it wrong in a different way than the
// service does).
//
// Pure: no Prisma, no React. `now` and the gateway floor are parameters, so a
// test can put a request three days in the past without touching the clock.
// =============================================================================

import { formatNotificationAge } from "./notification-view";
import { describePayoutAccount } from "./payout-account";

/** The one thing an admin can do next with a request in the queue. */
export type PayoutNextAction =
  /** PENDING: record the decision (which also sends it, when it can be sent). */
  | "APPROVE"
  /** APPROVED without a gateway id: a person has to send this one by hand. */
  | "SEND_BY_HAND"
  /** With the gateway, waiting for its verdict. */
  | "WAIT_FOR_GATEWAY"
  /** Something is not moving: read the gateway before doing anything else. */
  | "CHECK_GATEWAY";

/**
 * How long each state may sit before it is a problem.
 *
 * Not one number for every state, because they mean different things: nobody
 * reviewing a request for a day is a queue that is behind, while an approved
 * payout unsent for six hours is a creator who thinks they were paid and is not.
 */
const STUCK_AFTER_MINUTES: Record<PayoutNextAction, number> = {
  APPROVE: 24 * 60,
  SEND_BY_HAND: 6 * 60,
  WAIT_FOR_GATEWAY: 2 * 60,
  // Never a resting state: a send that started and left no record is already
  // past the point where the reconcile sweep flags it (see
  // UNCONFIRMED_SEND_MS in payout-disbursement.service.ts).
  CHECK_GATEWAY: 0,
};

/** The fields of a request this reads. A subset of the Prisma row. */
export interface PayoutForAttention {
  status: string;
  amount: number;
  createdAt: string | Date;
  paymentMethod: string;
  accountDetails: string;
  bankName?: string | null;
  providerWithdrawalId?: string | null;
  providerStatus?: string | null;
}

export interface PayoutAttention {
  /** Minutes since the creator asked — how long the money has been spoken for. */
  ageMinutes: number;
  /** The same age in the wording the notifications use ("3h ago"), "" if unreadable. */
  ageLabel: string;
  nextAction: PayoutNextAction;
  /** One imperative sentence, addressed to the admin. */
  action: string;
  /** True when this state has lasted longer than it may. */
  stuck: boolean;
}

const tzs = (amount: number) => `TZS ${amount.toLocaleString("en-US")}`;

/**
 * How long a row has waited, and what to do about it.
 *
 * `gatewayMinimum` is the floor the GATEWAY will send, not Genhub's waivable
 * one: a request under it can never go automatically, and saying so before the
 * admin presses approve is the difference between "this button is broken" and
 * "this one is mine to send".
 */
export function payoutAttention(
  payout: PayoutForAttention,
  options: { now?: number; gatewayMinimum: number }
): PayoutAttention {
  const now = options.now ?? Date.now();
  const floor = options.gatewayMinimum;
  const at = payout.createdAt instanceof Date ? payout.createdAt : new Date(payout.createdAt);
  const ageMinutes = Number.isFinite(at.getTime())
    ? Math.max(0, Math.floor((now - at.getTime()) / 60_000))
    : 0;
  const ageLabel = formatNotificationAge(payout.createdAt, now);
  // "3h ago" for a sentence, "3h" for a chip.
  const age = ageLabel ? ageLabel.replace(/ ago$/, "") : "some time";
  const where = describePayoutAccount(payout);
  const gatewayRef = payout.providerWithdrawalId;
  const gatewayStatus = (payout.providerStatus || "").trim();

  let nextAction: PayoutNextAction;
  let action: string;

  if (payout.status === "PENDING") {
    nextAction = "APPROVE";
    action =
      payout.amount < floor
        ? `Approve it, then send ${tzs(payout.amount)} to ${where} from your phone and mark it paid with the transaction code — it is under the gateway's ${tzs(floor)} floor, so it cannot go automatically.`
        : `Approve it — that sends ${tzs(payout.amount)} to ${where} through the gateway.`;
  } else if (gatewayRef) {
    // With the gateway. It is the only party that knows whether the money
    // arrived, so the admin's next move is to wait — unless it has waited long
    // enough that the answer is not coming on its own.
    nextAction = "WAIT_FOR_GATEWAY";
    action = `Sent to the gateway as withdrawal ${gatewayRef}${
      gatewayStatus ? ` (${gatewayStatus})` : ""
    } — wait for the confirmation; the reconcile sweep checks it.`;
  } else if (gatewayStatus === "sending") {
    // A send that was claimed and never recorded. Nothing can resolve this
    // automatically: the money may be with the gateway, and asking again could
    // pay the creator twice.
    nextAction = "CHECK_GATEWAY";
    action = `A gateway send was started ${age} ago and no withdrawal id was recorded — check the SonicPesa payouts dashboard for ${tzs(
      payout.amount
    )} to ${where} before doing anything else. Sending it again could pay twice.`;
  } else {
    // Approved and never sent: for a below-floor amount this is the permanent
    // state until a person picks up the phone.
    nextAction = "SEND_BY_HAND";
    action = `Approved ${age} ago and not sent — send ${tzs(payout.amount)} to ${where} from your phone, then mark it paid with the transaction code.`;
  }

  const stuck = ageMinutes >= STUCK_AFTER_MINUTES[nextAction];

  // Waiting too long for the gateway is the same problem as a send that left no
  // record: somebody has to look at the gateway rather than keep waiting.
  if (stuck && nextAction === "WAIT_FOR_GATEWAY") {
    nextAction = "CHECK_GATEWAY";
    action = `Withdrawal ${gatewayRef} has been with the gateway for ${age} and is still ${
      gatewayStatus || "unconfirmed"
    } — check it in the SonicPesa dashboard and the reconcile log rather than re-sending.`;
  }

  return { ageMinutes, ageLabel, nextAction, action, stuck };
}

/**
 * The queue in one line: how much is open, how much of it has stopped moving,
 * and which row has waited longest. Counts the rows it was given, so a paginated
 * queue describes the page an admin is looking at rather than the database.
 */
export function summarizePayoutAttention(
  rows: readonly { amount: number; attention: PayoutAttention }[]
): { open: number; stuck: number; waitingAmount: number; oldestAgeLabel: string | null } {
  let stuck = 0;
  let oldest = -1;
  let oldestLabel: string | null = null;
  let waitingAmount = 0;

  for (const row of rows) {
    if (row.attention.stuck) stuck += 1;
    waitingAmount += row.amount;
    if (row.attention.ageMinutes > oldest) {
      oldest = row.attention.ageMinutes;
      oldestLabel = row.attention.ageLabel || null;
    }
  }

  return { open: rows.length, stuck, waitingAmount, oldestAgeLabel: oldestLabel };
}
