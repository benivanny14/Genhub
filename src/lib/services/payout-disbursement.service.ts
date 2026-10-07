// =============================================================================
// GENHUB - Payout disbursement
//
// Turns an approved withdrawal request into money actually arriving on the
// creator's handset or bank account, through the same gateway that collects it.
//
// Before this existed, "withdraw" was a request and a debit and nothing else:
// the creator's balance dropped, an admin was supposed to send the money from
// their own phone, and a request could be marked PAID with a hand-typed string
// as its only proof. That is how a withdrawal ends up looking sent and never
// arriving.
//
// Three things this file is careful about, because they are the ways an
// automated payout loses money:
//
//   1. SENDING TWICE. `create` is claimed with a conditional update before the
//      gateway is called, so two admins (or an admin and a retry) cannot mint
//      two withdrawals for one request. The claim is on the same row the request
//      lives on, so it is atomic with the state it guards.
//   2. THE AMOUNT THE CREATOR GETS. The gateway charges a fee and pays the
//      recipient `net_amount`, which is LESS than the amount requested. Both
//      numbers are stored as the gateway reported them. Nothing here rounds or
//      infers: a creator who asked for 30,000 and received 28,200 is a fact the
//      platform has to be able to state.
//   3. FAILURE. A refusal from the gateway moves no money, so the request stays
//      open and its amount stays earmarked — the admin can fix the number and
//      retry, or reject it, which is what returns the money to the balance. A
//      payout that is accepted and then fails at the network is caught by the
//      `payout.failed` webhook or the reconcile sweep; both restore the balance.
//
// This file never decides "was it paid". The gateway does, through the webhook
// or the status poll — it is the only party that knows.
// =============================================================================

import prisma from "../db";
import config from "../config";
import {
  sonicpesaPayout,
  sonicpesaPayoutStatus,
  sonicpesaPayoutStatusToInternal,
  sonicpesaErrorReason,
  normalizeTzPhoneMsisdn,
  type SonicPesaPayoutMethod,
} from "../payments/sonicpesa";
import { recordAudit, AUDIT_ACTIONS } from "./audit.service";
import { createNotification } from "./notify.service";

export type DisburseOutcome =
  | {
      ok: true;
      payoutId: string;
      withdrawalId: number;
      amount: number;
      /** The gateway's cut. `netAmount` is what the creator receives. */
      fee: number;
      netAmount: number;
    }
  | {
      ok: false;
      reason:
        | "NOT_ENABLED"
        | "NOT_CONFIGURED"
        | "NOT_FOUND"
        | "ALREADY_SENT"
        | "WRONG_STATUS"
        | "UNSUPPORTED_METHOD"
        | "IN_FLIGHT"
        | "GATEWAY";
      message: string;
    };

/**
 * Our payout method -> the gateway's, or a refusal.
 *
 * Only methods the payout endpoint documents are mapped. A bank it cannot name
 * is NOT guessed at from a free-text field: sending money to the wrong bank is
 * worse than telling the admin to do this one by hand.
 */
const WALLET_METHODS: Record<string, SonicPesaPayoutMethod> = {
  MPESA: "M-Pesa",
  TIGO_PESA: "Tigo Pesa",
  AIRTEL_MONEY: "Airtel Money",
};

export function gatewayPayoutMethod(
  method: string,
  bankName?: string | null
): SonicPesaPayoutMethod | null {
  if (WALLET_METHODS[method]) return WALLET_METHODS[method];

  if (method === "BANK_TRANSFER") {
    const bank = (bankName || "").trim().toUpperCase();
    if (bank.includes("CRDB")) return "CRDB Bank";
    if (bank.includes("NMB")) return "NMB Bank";
    return null;
  }

  return null;
}

export interface DisburseParams {
  payoutId: string;
  /** The admin who approved it. Attributed in the audit line. */
  actorId: string;
}

export async function disbursePayout(params: DisburseParams): Promise<DisburseOutcome> {
  const { payoutId, actorId } = params;

  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutId },
    include: { creator: { select: { displayName: true, email: true } } },
  });

  if (!payout) {
    return { ok: false, reason: "NOT_FOUND", message: "Withdrawal request not found" };
  }

  // Idempotent: a request already at the gateway is never sent again.
  if (payout.providerWithdrawalId) {
    return {
      ok: false,
      reason: "ALREADY_SENT",
      message: `This withdrawal was already sent to the gateway (withdrawal ${payout.providerWithdrawalId}).`,
    };
  }

  if (payout.status !== "PENDING" && payout.status !== "APPROVED") {
    return {
      ok: false,
      reason: "WRONG_STATUS",
      message: `This request is already ${payout.status}, so nothing was sent.`,
    };
  }

  // Sending money out is a separate permission on the gateway account. Off
  // means "not available here", which the admin handles by sending it by hand —
  // not a failure of the request.
  // These two sentences reach the admin screen, so they are written for the
  // person reading them and name no switch or variable: which variable to set is
  // an operator's business, and it goes to the log instead.
  if (!config.sonicPesa.payoutsEnabled) {
    console.log(
      "[Payout] Automatic payouts are off for this deployment; an admin must send this withdrawal by hand."
    );
    return {
      ok: false,
      reason: "NOT_ENABLED",
      message:
        "Automatic payouts are switched off for this deployment. Send this withdrawal by hand, then mark it paid with the receipt.",
    };
  }

  if (!config.sonicPesa.accessKey || !config.sonicPesa.apiSecret) {
    console.error(
      "[Payout] Automatic payouts are enabled but the gateway credentials are incomplete — check the payout API secret on this deployment."
    );
    return {
      ok: false,
      reason: "NOT_CONFIGURED",
      message:
        "Automatic payouts are on but this deployment's payout credentials are incomplete. Send this withdrawal by hand, then mark it paid with the receipt.",
    };
  }

  const method = gatewayPayoutMethod(payout.paymentMethod, payout.bankName);
  if (!method) {
    return {
      ok: false,
      reason: "UNSUPPORTED_METHOD",
      message:
        payout.paymentMethod === "BANK_TRANSFER"
          ? `The gateway cannot be told which bank "${payout.bankName || ""}" is, so this one has to be sent by hand.`
          : `The gateway does not support ${payout.paymentMethod} payouts.`,
    };
  }

  const rawNumber = (payout.accountDetails || "").trim();
  if (!rawNumber) {
    return { ok: false, reason: "UNSUPPORTED_METHOD", message: "This request has no account to pay." };
  }

  // Wallets want country-code MSISDN (255…); a bank account number is passed
  // through untouched, because its digits are the account, not a phone.
  const accountNumber =
    payout.paymentMethod === "BANK_TRANSFER"
      ? rawNumber.replace(/\s+/g, "")
      : normalizeTzPhoneMsisdn(rawNumber);

  const accountName =
    (payout.creator?.displayName || "").trim() ||
    (payout.creator?.email || "").split("@")[0] ||
    "Genhub creator";

  // Claim the row BEFORE calling the gateway. Two callers racing here both
  // cannot win: the second sees a row that is no longer claimable and stops
  // without sending anything. `providerStatus: "sending"` is a marker, not a
  // verdict — it is overwritten by the gateway's real answer below, and by the
  // sweep if this process dies mid-call.
  const claimed = await prisma.payoutRequest.updateMany({
    where: { id: payoutId, providerWithdrawalId: null, status: { in: ["PENDING", "APPROVED"] } },
    data: { providerStatus: "sending" },
  });

  if (claimed.count !== 1) {
    return {
      ok: false,
      reason: "IN_FLIGHT",
      message: "This withdrawal is already being sent. Nothing was sent twice.",
    };
  }

  let result;
  try {
    result = await sonicpesaPayout({
      amount: payout.amount,
      method,
      accountNumber,
      accountName,
    });
  } catch (error) {
    const reason = sonicpesaErrorReason(error);
    // Hand the claim back so the admin can correct the number and retry. No
    // money moved and no balance changed: this is a refusal, not a failure.
    await prisma.payoutRequest
      .updateMany({
        where: { id: payoutId, providerWithdrawalId: null },
        data: { providerStatus: null },
      })
      .catch(() => {});

    await recordAudit({
      actorId,
      action: AUDIT_ACTIONS.payoutApprove,
      targetType: "PayoutRequest",
      targetId: payoutId,
      summary: `Gateway refused the payout of TZS ${payout.amount.toLocaleString()}: ${reason}`,
      detail: {
        amount: payout.amount,
        creatorId: payout.creatorId,
        paymentMethod: payout.paymentMethod,
        gatewayMethod: method,
        gatewayError: reason,
        moneyMoved: false,
      },
    });

    return { ok: false, reason: "GATEWAY", message: reason };
  }

  if (!result.success || !result.payout) {
    await prisma.payoutRequest
      .updateMany({
        where: { id: payoutId, providerWithdrawalId: null },
        data: { providerStatus: null },
      })
      .catch(() => {});
    return {
      ok: false,
      reason: "GATEWAY",
      message: result.error || "The gateway did not accept the payout",
    };
  }

  const w = result.payout;

  // The money is with the gateway now. APPROVED, not PAID: only the gateway's
  // own verdict makes it PAID, through the webhook or the status poll.
  await prisma.payoutRequest.update({
    where: { id: payoutId },
    data: {
      status: "APPROVED",
      providerWithdrawalId: String(w.withdrawalId),
      providerFee: w.fee,
      providerNetAmount: w.netAmount,
      providerStatus: w.status || "pending",
      processedBy: actorId,
      processedAt: new Date(),
    },
  });

  await recordAudit({
    actorId,
    action: AUDIT_ACTIONS.payoutApprove,
    targetType: "PayoutRequest",
    targetId: payoutId,
    summary: `Sent TZS ${payout.amount.toLocaleString()} of ${
      payout.creator?.displayName || payout.creator?.email || payout.creatorId
    } through the gateway (withdrawal ${w.withdrawalId}, fee TZS ${w.fee.toLocaleString()}, creator receives TZS ${w.netAmount.toLocaleString()})`,
    detail: {
      amount: payout.amount,
      creatorId: payout.creatorId,
      paymentMethod: payout.paymentMethod,
      gatewayMethod: method,
      providerWithdrawalId: w.withdrawalId,
      fee: w.fee,
      netAmount: w.netAmount,
      accountNumber,
    },
  });

  return {
    ok: true,
    payoutId,
    withdrawalId: w.withdrawalId,
    amount: payout.amount,
    fee: w.fee,
    netAmount: w.netAmount,
  };
}

// =============================================================================
// Settling what the gateway did
//
// The only party that knows whether money reached the handset is the gateway.
// Two things tell us: its `payout.*` webhook, and the status poll the sweep
// runs. Both funnel through here so a payout can never be completed by one path
// in a way the other does not understand.
//
// Every branch is idempotent. A webhook is delivered more than once in practice,
// and a failed payout is exactly the kind of event that gets retried — the one
// outcome that must never happen is a refund credited twice.
// =============================================================================

export type PayoutSettlementStatus = "PAID" | "FAILED" | "PENDING" | "UNKNOWN";

export interface PayoutSettlement {
  /** False when the withdrawal id matches no request of ours (nothing to do). */
  handled: boolean;
  status: PayoutSettlementStatus;
  payoutId?: string;
  /** True when this call moved money back to the creator's balance. */
  refunded?: boolean;
  detail: string;
}

/** The reference a creator reads when an automated payout succeeded. */
export function gatewayPayoutReference(withdrawalId: string | number): string {
  return `SP-${withdrawalId}`;
}

export interface SettlePayoutParams {
  withdrawalId: string | number;
  /** The gateway's own status/event word, e.g. "completed", "failed". */
  gatewayStatus: string;
  /** Where the verdict came from. Recorded, so a poll and a webhook differ. */
  source: "webhook" | "reconcile";
  fee?: number;
  netAmount?: number;
}

export async function settlePayoutFromGateway(
  params: SettlePayoutParams
): Promise<PayoutSettlement> {
  const { withdrawalId, gatewayStatus, source, fee, netAmount } = params;

  const payout = await prisma.payoutRequest.findFirst({
    where: { providerWithdrawalId: String(withdrawalId) },
    select: {
      id: true,
      creatorId: true,
      amount: true,
      status: true,
      accountDetails: true,
      paymentMethod: true,
      providerNetAmount: true,
    },
  });

  if (!payout) {
    return {
      handled: false,
      status: "UNKNOWN",
      detail: `No withdrawal request for gateway payout ${withdrawalId}`,
    };
  }

  const verdict = sonicpesaPayoutStatusToInternal(gatewayStatus);

  if (!verdict) {
    // Still in flight. Record the gateway's word so a stuck payout is visibly
    // stuck rather than apparently untouched.
    await prisma.payoutRequest.update({
      where: { id: payout.id },
      data: {
        providerStatus: gatewayStatus || "pending",
        ...(typeof fee === "number" ? { providerFee: fee } : {}),
        ...(typeof netAmount === "number" ? { providerNetAmount: netAmount } : {}),
      },
    });
    return {
      handled: true,
      status: "PENDING",
      payoutId: payout.id,
      detail: `Gateway still reports ${gatewayStatus} for payout ${withdrawalId}`,
    };
  }

  if (verdict === "PAID") {
    // Already settled — a duplicate delivery must not re-notify or re-write.
    if (payout.status === "PAID") {
      return {
        handled: true,
        status: "PAID",
        payoutId: payout.id,
        detail: "Payout already marked paid",
      };
    }

    const net = netAmount ?? payout.providerNetAmount ?? payout.amount;

    // Conditional on not already being PAID, so two deliveries cannot both flip
    // it and send two notifications.
    const moved = await prisma.payoutRequest.updateMany({
      where: { id: payout.id, status: { not: "PAID" } },
      data: {
        status: "PAID",
        providerStatus: gatewayStatus || "completed",
        // The gateway's own id IS the receipt for an automated payout: there is
        // no human-readable M-Pesa code, and inventing one would be a lie.
        paymentReference: gatewayPayoutReference(withdrawalId),
        processedAt: new Date(),
        ...(typeof fee === "number" ? { providerFee: fee } : {}),
        ...(typeof netAmount === "number" ? { providerNetAmount: netAmount } : {}),
      },
    });

    if (moved.count === 1) {
      await notify(
        payout.creatorId,
        "Withdrawal sent 💸",
        `TZS ${payout.amount.toLocaleString()} has been sent to ${payout.accountDetails}. ` +
          `You receive about TZS ${net.toLocaleString()} after the fee. Reference: ${gatewayPayoutReference(withdrawalId)}.`,
        "success"
      );
      await recordAudit({
        actorId: "system",
        action: AUDIT_ACTIONS.payoutPaid,
        targetType: "PayoutRequest",
        targetId: payout.id,
        summary: `Gateway confirmed payout of TZS ${payout.amount.toLocaleString()} (${source}, withdrawal ${withdrawalId})`,
        detail: { amount: payout.amount, netAmount: net, withdrawalId, source },
      });
    }

    return {
      handled: true,
      status: "PAID",
      payoutId: payout.id,
      detail: `Payout ${withdrawalId} is paid`,
    };
  }

  // FAILED — the money did not reach the account, so it goes back.
  if (payout.status === "REJECTED") {
    return {
      handled: true,
      status: "FAILED",
      payoutId: payout.id,
      detail: "Payout already returned to the creator's balance",
    };
  }

  const note = `The mobile-money transfer could not be completed at the network, so the amount was returned to your available balance. You can request it again.${gatewayStatus ? ` (gateway: ${gatewayStatus})` : ""}`;

  // The balance and the status move together or not at all: a request marked
  // failed without its money back is worse than one still open.
  const refunded = await prisma.$transaction(async (tx) => {
    const moved = await tx.payoutRequest.updateMany({
      where: { id: payout.id, status: { notIn: ["REJECTED", "PAID"] } },
      data: {
        status: "REJECTED",
        providerStatus: gatewayStatus || "failed",
        adminNote: note,
        processedAt: new Date(),
      },
    });
    if (moved.count !== 1) return false;

    await tx.creatorBalance.update({
      where: { creatorId: payout.creatorId },
      data: { availableBalance: { increment: payout.amount } },
    });
    return true;
  });

  if (refunded) {
    await notify(payout.creatorId, "Withdrawal did not go through", note, "error");
    await recordAudit({
      actorId: "system",
      action: AUDIT_ACTIONS.payoutReject,
      targetType: "PayoutRequest",
      targetId: payout.id,
      summary: `Gateway failed payout of TZS ${payout.amount.toLocaleString()} — funds returned (${source}, withdrawal ${withdrawalId})`,
      detail: {
        amount: payout.amount,
        withdrawalId,
        source,
        gatewayStatus,
        fundsReturned: true,
      },
    });
  }

  return {
    handled: true,
    status: "FAILED",
    payoutId: payout.id,
    refunded,
    detail: refunded
      ? `Payout ${withdrawalId} failed and TZS ${payout.amount.toLocaleString()} was returned`
      : `Payout ${withdrawalId} was already settled`,
  };
}

// =============================================================================
// Reconcile — ask the gateway about payouts it has not told us about
//
// A webhook can be missed, and a payout that the network completes silently is
// the worst version of that: the creator has the money, and our row still says
// "approved". So the scheduled reconcile asks directly, exactly as it does for
// charges — the gateway is the only party that knows.
// =============================================================================

export interface PayoutReconcileResult {
  checked: number;
  /** Moved to PAID by this run. */
  settled: number;
  /** The network failed them; the amount was returned to the creator. */
  failed: number;
  stillPending: number;
  /**
   * Rows claimed for sending whose gateway id never got written — a send that
   * started and whose record did not land. Nothing here can resolve them
   * automatically (re-sending risks paying twice), so they are surfaced for a
   * human to check against the gateway dashboard.
   */
  stuckUnconfirmed: number;
  errors: number;
}

/** How long a claimed-but-unrecorded send is tolerated before it is flagged. */
const UNCONFIRMED_SEND_MS = 10 * 60 * 1000;

export async function reconcilePayouts(options?: {
  olderThanMinutes?: number;
  limit?: number;
}): Promise<PayoutReconcileResult> {
  const olderThanMinutes = options?.olderThanMinutes ?? 10;
  const limit = options?.limit ?? 50;

  const result: PayoutReconcileResult = {
    checked: 0,
    settled: 0,
    failed: 0,
    stillPending: 0,
    stuckUnconfirmed: 0,
    errors: 0,
  };

  // Nothing to ask about when payouts cannot be sent in the first place.
  if (!config.sonicPesa.payoutsEnabled || !config.sonicPesa.apiSecret) return result;

  // A send that was claimed but never recorded. Counted, never retried here.
  const stuck = await prisma.payoutRequest.count({
    where: {
      providerWithdrawalId: null,
      providerStatus: "sending",
      updatedAt: { lt: new Date(Date.now() - UNCONFIRMED_SEND_MS) },
    },
  });
  if (stuck > 0) {
    result.stuckUnconfirmed = stuck;
    console.error(
      `[Payout Reconcile] ${stuck} payout(s) were claimed for sending but never recorded a gateway id. ` +
        "Check the SonicPesa payouts dashboard for withdrawals matching these requests before doing anything else — " +
        "re-sending one could pay the creator twice."
    );
  }

  const open = await prisma.payoutRequest.findMany({
    where: {
      providerWithdrawalId: { not: null },
      status: { notIn: ["PAID", "REJECTED"] },
      updatedAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    select: { id: true, providerWithdrawalId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  for (const row of open) {
    result.checked += 1;
    try {
      const reply = await sonicpesaPayoutStatus(row.providerWithdrawalId as string);
      if (!reply.success || !reply.payout) {
        result.errors += 1;
        continue;
      }

      const settlement = await settlePayoutFromGateway({
        withdrawalId: row.providerWithdrawalId as string,
        gatewayStatus: reply.payout.status,
        source: "reconcile",
        fee: reply.payout.fee,
        netAmount: reply.payout.netAmount,
      });

      if (settlement.status === "PAID") result.settled += 1;
      else if (settlement.status === "FAILED") result.failed += 1;
      else result.stillPending += 1;
    } catch (error) {
      result.errors += 1;
      console.warn(
        `[Payout Reconcile] Could not read payout ${row.providerWithdrawalId}:`,
        sonicpesaErrorReason(error)
      );
    }
  }

  return result;
}

/** Best-effort creator notification — a failure here never blocks the money. */
async function notify(
  userId: string,
  title: string,
  message: string,
  type: "success" | "error"
): Promise<void> {
  try {
    await createNotification({ userId, title, message, type, link: "/creator", pushTag: "payout" });
  } catch (error) {
    console.warn("[Payout] Notification failed:", (error as Error)?.message);
  }
}
