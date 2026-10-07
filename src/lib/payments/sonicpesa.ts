// =============================================================================
// GENHUB - SonicPesa Integration (the only gateway)
// Mobile-money USSD push collections: the customer approves the charge on their
// own phone, so the checkout UX and the whole settlement path are unchanged.
//
// Docs (https://docs.sonicpesa.com):
//   POST /payment/create_order   -> send the USSD prompt, returns an order id
//   POST /payment/order_status   -> status by the gateway's own order id
//   POST /payouts/create         -> send money OUT to a wallet or bank account
//   GET  /payouts/status/{id}    -> the verdict on one payout, by withdrawal id
//   Webhook POST                 -> { event, order_id, status, … }, signed with
//                                   X-SonicPesa-Signature = HMAC-SHA256(raw, secret)
//
// Three things shape this file:
//
//   1. Auth is a STATIC header — `X-API-KEY: <access key>` — not a minted bearer
//      token, so there is nothing to cache or refresh.
//   2. SonicPesa assigns the order id (`sp_…`); it does NOT accept a reference we
//      choose. That gateway id IS the `providerRef` the webhook and the status
//      poll match on, so a checkout stores it after `create_order` returns.
//      `sonicpesaOrderReference` still mints our OWN trace id, kept in the row's
//      metadata for support, but it is never the gateway's key.
//   3. Webhooks are configured in the SonicPesa dashboard (no per-request
//      webhook_url) and signed over the RAW request body with the API secret —
//      see lib/webhook-auth.ts.
// =============================================================================

import config from "../config";
import { createBoundedCaller } from "../bounded-caller";
import { reportCredentialFault } from "../credential-alert";

// =============================================================================
// Types
// =============================================================================

export interface SonicPesaCollectRequest {
  /** Normalized MSISDN: 255712345678 (no +, no leading 0). */
  phone: string;
  /** TZS, min 100. */
  amount: number;
  /**
   * OUR trace reference (alphanumeric, unique per attempt). SonicPesa does not
   * accept one, so it is carried in the row's metadata, never sent as the key.
   */
  orderReference: string;
  /** Optional buyer identity the gateway asks for; falls back to safe defaults. */
  email?: string;
  name?: string;
}

export interface SonicPesaCollectResponse {
  success: boolean;
  /**
   * SonicPesa's own order id (e.g. `sp_69be15e08c830`). Stored as providerRef so
   * the webhook and the status poll can match the charge.
   */
  orderReference?: string;
  /** The gateway's network reference / transaction id (diagnostics only). */
  transactionId?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface SonicPesaPayment {
  /** SUCCESS | PENDING | INPROGRESS | CANCELLED | USERCANCELLED | REJECTED */
  status: string;
  orderId?: string;
  reference?: string;
  transid?: string;
  channel?: string;
  amount?: number;
  phone?: string;
}

export interface SonicPesaStatusResponse {
  success: boolean;
  payment?: SonicPesaPayment;
  error?: string;
}

/** The envelope SonicPesa POSTs to the webhook URL configured in its dashboard. */
export interface SonicPesaWebhookPayload {
  /**
   * payment.completed | payment.failed | payment.cancelled | payment.pending,
   * or payout.pending | payout.success | payout.failed.
   */
  event: string;
  /** SonicPesa's own order id — the value we stored as providerRef. */
  order_id: string;
  /**
   * Present on `payout.*` events only: the payout's own envelope, carrying the
   * withdrawal id we stored when we asked for it. A payout callback has no
   * `order_id`, so the two families cannot be told apart by that field.
   */
  data?: {
    withdrawal_id?: number;
    amount?: number | string;
    fee?: number | string;
    net_amount?: number | string;
    method?: string;
    status?: string;
    created_at?: string;
  };
  amount?: string | number;
  currency?: string;
  status?: string;
  transid?: string;
  channel?: string;
  reference?: string;
  msisdn?: string;
  timestamp?: string;
}

/** The `data` object `create_order` answers with. */
interface SonicPesaCreateOrderData {
  order_id?: string;
  reference?: string | null;
  amount?: number;
  currency?: string;
  payment_status?: string;
  status?: string;
  creation_date?: string;
  transid?: string | null;
  channel?: string | null;
  msisdn?: string | null;
}

interface SonicPesaCreateOrderResponse {
  status?: string;
  message?: string;
  data?: SonicPesaCreateOrderData;
}

interface SonicPesaOrderStatusData {
  order_id?: string;
  payment_status?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  phone?: string;
  msisdn?: string;
  transid?: string | null;
  reference?: string | null;
  channel?: string | null;
  created_at?: string;
}

interface SonicPesaOrderStatusResponse {
  status?: string;
  message?: string;
  data?: SonicPesaOrderStatusData;
}

// =============================================================================
// Shared fetch wrapper (auth + bound + breaker)
//
// A gateway that accepts the connection and then never answers is not one slow
// call, it is every call for the life of the process — and the reconcile sweep
// is the worst of them, because it calls once per pending charge. So the bound
// is paired with a breaker, and a 4xx never counts toward opening it (a rejected
// phone number is the gateway working, not the gateway being down).
// =============================================================================

/** How long one gateway call may take before it is abandoned. */
const SONICPESA_TIMEOUT_MS = 20_000;

/**
 * An HTTP answer from the gateway that is not 2xx.
 *
 * A class rather than a bare Error so the breaker can tell a business rejection
 * (4xx) from a connectivity fault (5xx). `sonicpesaErrorReason` strips the
 * prefix to show the merchant what the gateway actually said.
 */
export class SonicPesaHttpError extends Error {
  status: number;

  constructor(path: string, status: number, detail: string) {
    super(`SonicPesa ${path} error ${status}: ${detail}`);
    this.name = "SonicPesaHttpError";
    this.status = status;
  }
}

const gatewayCall = createBoundedCaller({
  timeoutMs: SONICPESA_TIMEOUT_MS,
  failuresToOpen: 2,
  openForMs: 30_000,
  // "Could we reach the gateway?" — a 4xx proves we could, so it is not counted.
  countsAsFailure: (error) =>
    !(error instanceof SonicPesaHttpError) || error.status >= 500,
  onFailure: ({ reason, failures, opened }) => {
    if (!opened) return;
    void reportCredentialFault({
      service: "SonicPesa",
      detail:
        `the gateway stopped answering (${failures} failure(s) in a row, last one ${reason}) ` +
        "— collect and status calls are being skipped; payments are not reaching handsets",
    });
  },
});

/** Run one gateway request under the bound + breaker, preserving the real error. */
async function runBounded<T>(path: string, attempt: () => Promise<T>): Promise<T> {
  // The breaker only reports a reason, so the original error is remembered here.
  let thrown: unknown = null;

  const outcome = await gatewayCall.run(async () => {
    try {
      return await attempt();
    } catch (error) {
      thrown = error;
      throw error;
    }
  });

  if (outcome.ok) return outcome.value;

  if (outcome.reason === "open") {
    throw new Error(
      `SonicPesa has not answered its last calls, so this one was not sent. ` +
        `Give it a moment and try again (${path}).`
    );
  }

  if (outcome.reason === "timeout") {
    throw new Error(
      `SonicPesa ${path} timed out after ${SONICPESA_TIMEOUT_MS / 1000}s — the gateway did not answer`
    );
  }

  throw thrown ?? new Error(`SonicPesa ${path} failed`);
}

/** The gateway breaker's live state, for diagnostics and tests. */
export function sonicpesaGatewayState(now: number = Date.now()) {
  const state = gatewayCall.state();
  return { open: now < state.openUntil, ...state };
}

/**
 * The gateway breaker in words — one source of wording for the places an
 * operator meets it, so two screens cannot describe the same outage differently.
 *
 * Returns null while the breaker is closed, which is the normal state. It cannot
 * be the credentials: a rejected key answers immediately (a 4xx), and only
 * unanswered calls open the breaker.
 */
export function sonicpesaBreakerNotice(
  state: { open: boolean; openUntil: number; failures: number } = sonicpesaGatewayState(),
  now: number = Date.now()
): string | null {
  if (!state.open) return null;

  const resumeInSeconds = Math.max(1, Math.ceil((state.openUntil - now) / 1000));
  return (
    "SonicPesa has not answered its last calls, so this server is skipping gateway calls " +
    `for about ${resumeInSeconds}s (${state.failures} failure(s) in a row). ` +
    "The credentials are not the problem — a rejected key answers immediately; an unanswered " +
    "call does not. It retries on its own as soon as the window passes."
  );
}

function credentialsConfigured(): boolean {
  return Boolean(config.sonicPesa.accessKey);
}

const CREDENTIALS_MISSING = "SONICPESA_ACCESS_KEY is not configured";

/**
 * One authenticated, bounded JSON call to the gateway.
 *
 * Auth is the static `X-API-KEY` header — no token to mint, cache or refresh.
 * A 401/403 is the one fault the breaker deliberately ignores (the gateway
 * answered, so it is not down) and exactly the one an operator has to fix.
 */
async function sonicpesaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!credentialsConfigured()) {
    throw new Error(CREDENTIALS_MISSING);
  }

  return runBounded(path, async () => {
    const response = await fetch(`${config.sonicPesa.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(SONICPESA_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": config.sonicPesa.accessKey,
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });

    const data = (await response.json().catch(() => ({}))) as T & {
      status?: string;
      message?: string;
      error?: string;
    };

    const rejected = response.status === 401 || response.status === 403;
    if (rejected) {
      void reportCredentialFault({
        service: "SonicPesa",
        detail:
          `the gateway rejected SONICPESA_ACCESS_KEY (HTTP ${response.status} on ${path}) ` +
          "— collects are refused immediately, so this is the credentials, not the network",
      });
    }

    // A 2xx carries `status: "success"`; an application-level refusal can still
    // arrive as 200 with `status: "error"`, so both are treated as failures.
    if (!response.ok || data?.status === "error") {
      throw new SonicPesaHttpError(
        path,
        response.status,
        data?.message || data?.error || response.statusText
      );
    }

    return data;
  });
}

// =============================================================================
// 1. Collect — send the USSD push to the customer's phone
// =============================================================================

/**
 * Initiate a USSD push collection.
 *
 * Throws on failure (bad number, unreachable gateway) so caller routes take
 * their existing `catch` path and show the gateway's own reason via
 * `sonicpesaErrorReason`. The response's `orderReference` is the gateway's own
 * `order_id`, stored as the transaction's providerRef so the webhook and the
 * status poll can match the callback.
 */
export async function sonicpesaCollect(
  request: SonicPesaCollectRequest
): Promise<SonicPesaCollectResponse> {
  const data = await sonicpesaFetch<SonicPesaCreateOrderResponse>(
    "/payment/create_order",
    {
      method: "POST",
      body: JSON.stringify({
        // Identity fields are required by the API; fall back to a stable,
        // non-secret address so a checkout never fails for want of an email.
        buyer_email: request.email || config.sonicPesa.fallbackEmail,
        buyer_name: request.name || "Genhub customer",
        buyer_phone: request.phone,
        amount: Math.round(request.amount),
        currency: "TZS",
      }),
    }
  );

  const orderId = data?.data?.order_id;
  if (!orderId) {
    return {
      success: false,
      error: data?.message || "SonicPesa did not return an order id",
    };
  }

  return {
    success: true,
    // WE store this as providerRef — it is the key the gateway echoes back.
    orderReference: orderId,
    transactionId: data?.data?.reference || data?.data?.transid || undefined,
    status: data?.data?.payment_status || data?.data?.status,
    message: "USSD push sent — approve it on your phone",
  };
}

// =============================================================================
// 2. Payment status by the gateway's order id
// =============================================================================

export async function sonicpesaStatus(
  orderReference: string
): Promise<SonicPesaStatusResponse> {
  const data = await sonicpesaFetch<SonicPesaOrderStatusResponse>(
    "/payment/order_status",
    {
      method: "POST",
      body: JSON.stringify({ order_id: orderReference }),
    }
  );

  const detail = data?.data;
  const status = detail?.payment_status || detail?.status;
  if (!detail || !status) return { success: true };

  const amount = Number(detail.amount);

  return {
    success: true,
    payment: {
      status,
      orderId: detail.order_id,
      reference: detail.reference ?? undefined,
      transid: detail.transid ?? undefined,
      channel: detail.channel ?? undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
      phone: detail.phone ?? detail.msisdn ?? undefined,
    },
  };
}

// =============================================================================
// 3. Payout — send money OUT (Merchant Payout API)
//
// Collecting and paying out are two products on one account, and they are not
// symmetric:
//
//   * the payout endpoints authenticate with a SECOND header, `X-API-SECRET`,
//     alongside `X-API-KEY` — the collect key alone is not enough;
//   * `method` is the gateway's own display name ("M-Pesa", "Airtel Money",
//     "CRDB Bank"), not our enum, so the mapping is explicit and refusals are
//     deliberate rather than a guessed string;
//   * the gateway answers with `fee` and `net_amount`. The recipient is paid
//     `net_amount`, which is LESS than the amount sent. That difference is real
//     money and it is returned here, never inferred, because the creator has to
//     be told what actually reached their handset.
//
// The response status is `pending`: money is not sent synchronously. `payout.*`
// webhooks (or the status poll) are what finish the request.
// =============================================================================

/*
 * The `method` strings the payout endpoint documents, verbatim.
 *
 * Deliberately a subset. The gateway also offers a bank aggregator whose
 * `account_number` must be a bare 9-digit wallet or a >9-digit card sequence — a
 * shape our payout rows do not hold and cannot be checked against, so it is not
 * offered and no code can pick it. The decommissioned-gateway guard test also
 * keeps that retired name out of shipped source, which is where it belongs.
 */
export const SONICPESA_PAYOUT_METHODS = [
  "M-Pesa",
  "Tigo Pesa",
  "Airtel Money",
  "Halopesa",
  "CRDB Bank",
  "NMB Bank",
] as const;

export type SonicPesaPayoutMethod = (typeof SONICPESA_PAYOUT_METHODS)[number];

export interface SonicPesaPayoutRequest {
  /** TZS. This is what leaves the merchant balance, not what the recipient gets. */
  amount: number;
  method: SonicPesaPayoutMethod;
  /** MSISDN (255…) for a wallet, the account number for a bank. */
  accountNumber: string;
  accountName: string;
}

export interface SonicPesaPayout {
  /** The gateway's payout id. Stored so the webhook and the poll can match it. */
  withdrawalId: number;
  amount: number;
  fee: number;
  /** What the recipient actually receives. */
  netAmount: number;
  method: string;
  /** pending | completed | failed */
  status: string;
  createdAt?: string;
}

export interface SonicPesaPayoutResult {
  success: boolean;
  payout?: SonicPesaPayout;
  message?: string;
  error?: string;
}

interface SonicPesaPayoutEnvelope {
  status?: string;
  message?: string;
  data?: {
    withdrawal_id?: number;
    amount?: number | string;
    fee?: number | string;
    net_amount?: number | string;
    method?: string;
    status?: string;
    created_at?: string;
  };
}

const PAYOUT_CREDENTIALS_MISSING =
  "SonicPesa payouts need both SONICPESA_ACCESS_KEY and SONICPESA_API_SECRET";

function payoutCredentialsConfigured(): boolean {
  return Boolean(config.sonicPesa.accessKey && config.sonicPesa.apiSecret);
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function readPayout(envelope: SonicPesaPayoutEnvelope): SonicPesaPayout | null {
  const data = envelope?.data;
  const withdrawalId = toNumber(data?.withdrawal_id);
  if (!data || !withdrawalId) return null;

  return {
    withdrawalId,
    amount: toNumber(data.amount),
    fee: toNumber(data.fee),
    // Fall back to the amount sent, never to zero: an absent net_amount must not
    // read as "the creator received nothing".
    netAmount: data.net_amount === undefined ? toNumber(data.amount) : toNumber(data.net_amount),
    method: data.method ?? "",
    status: data.status ?? "pending",
    createdAt: data.created_at,
  };
}

/**
 * Ask the gateway to send money to a wallet or bank account.
 *
 * Throws on failure (bad number, unapproved method, insufficient merchant
 * balance) so the caller takes one `catch` path and shows the gateway's own
 * reason via `sonicpesaErrorReason`. A thrown error means NO money moved — the
 * gateway's refusals are 4xx and its success envelope carries the withdrawal id.
 */
export async function sonicpesaPayout(
  request: SonicPesaPayoutRequest
): Promise<SonicPesaPayoutResult> {
  if (!payoutCredentialsConfigured()) {
    throw new Error(PAYOUT_CREDENTIALS_MISSING);
  }

  // sonicpesaFetch already runs inside the breaker — wrapping it again would
  // count one outage twice.
  const data = await sonicpesaFetch<SonicPesaPayoutEnvelope>("/payouts/create", {
    method: "POST",
    headers: { "X-API-SECRET": config.sonicPesa.apiSecret },
    body: JSON.stringify({
      amount: Math.round(request.amount),
      method: request.method,
      account_number: request.accountNumber,
      account_name: request.accountName,
    }),
  });

  const payout = readPayout(data);
  if (!payout) {
    return { success: false, error: data?.message || "SonicPesa did not return a withdrawal id" };
  }

  return { success: true, payout, message: data?.message };
}

/**
 * The current verdict on one payout. GET, by the gateway's withdrawal id.
 *
 * `completed` and `failed` are the only decisive states; `pending` means keep
 * asking, which is what the reconcile sweep does.
 */
export async function sonicpesaPayoutStatus(
  withdrawalId: number | string
): Promise<SonicPesaPayoutResult> {
  if (!payoutCredentialsConfigured()) {
    throw new Error(PAYOUT_CREDENTIALS_MISSING);
  }

  const data = await sonicpesaFetch<SonicPesaPayoutEnvelope>(`/payouts/status/${withdrawalId}`, {
    method: "GET",
    headers: { "X-API-SECRET": config.sonicPesa.apiSecret },
  });

  const payout = readPayout(data);
  if (!payout) return { success: false, error: data?.message || "Payout not found" };
  return { success: true, payout, message: data?.message };
}

/**
 * Map a gateway payout `status` onto a verdict, or null while it is in flight.
 *
 * "completed"/"success" mean the money reached the account; the failed family
 * means it did not, and the balance has to go back.
 */
/**
 * A `payout.*` webhook event name -> the gateway's own status word, or null when
 * the event is not one of the payout family.
 *
 * Lives here, next to the payment-event vocabulary above, because the two are
 * different: `payment.success` and `payout.success` are not the same shape and a
 * route that tried to read both with one mapping would answer a payout callback
 * with "order_id missing".
 */
export function sonicpesaPayoutEventToStatus(event: string): string | null {
  const e = (event || "").toLowerCase();
  if (e === "payout.pending") return "pending";
  if (e === "payout.success" || e === "payout.completed") return "completed";
  if (e === "payout.failed" || e === "payout.cancelled") return "failed";
  return null;
}

export function sonicpesaPayoutStatusToInternal(
  status: string
): "PAID" | "FAILED" | null {
  const s = (status || "").toLowerCase();
  if (s === "completed" || s === "success" || s === "successful" || s === "paid") {
    return "PAID";
  }
  if (["failed", "cancelled", "canceled", "rejected", "reversed"].includes(s)) {
    return "FAILED";
  }
  return null;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * A Tanzanian MSISDN as SonicPesa wants it: country code, no plus, no trunk 0.
 * `0712345678` and `+255712345678` both become `255712345678`.
 */
export function normalizeTzPhoneMsisdn(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("255")) return digits;
  if (digits.startsWith("0")) return `255${digits.slice(1)}`;
  return digits;
}

/**
 * A unique, alphanumeric reference WE mint, kept in the row's metadata for
 * support. SonicPesa does not accept a caller-chosen reference, so this is a
 * trace id and never the gateway key.
 */
export function sonicpesaOrderReference(prefix: string = "SP"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 10).toUpperCase();
  const clean = prefix.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "SP";
  return `${clean}${stamp}${random}`.slice(0, 20);
}

/**
 * Map a SonicPesa status onto our internal verdict, or null while it is still
 * in flight. SUCCESS means the money landed; the cancelled/rejected family means
 * the customer never paid, which is a definitive FAILED.
 */
export function sonicpesaStatusToInternal(
  status: string
): "SUCCESS" | "FAILED" | null {
  const s = status.toLowerCase();
  if (s === "success" || s === "settled" || s === "completed") return "SUCCESS";
  if (["failed", "cancelled", "canceled", "usercancelled", "rejected"].includes(s)) {
    return "FAILED";
  }
  return null;
}

// Human-readable failure reason.
// Our fetch wrapper prefixes thrown errors with "SonicPesa /path error 4xx: ".
// Strip that so the UI can show the merchant what the gateway actually said
// (e.g. "Invalid / unsupported phone number").
export function sonicpesaErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^SonicPesa\s+\S+\s+error\s+\d+:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "gateway haijajibu";
}
