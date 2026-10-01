// =============================================================================
// GENHUB - ClickPesa Integration (the only gateway)
// Mobile-money USSD push collections: the customer approves the charge on their
// own phone, exactly like the gateway this replaced, so the checkout UX and the
// whole settlement path are unchanged.
//
// Docs (https://docs.clickpesa.com):
//   POST /generate-token                              -> { success, token } (already "Bearer …", lives 1h)
//   POST /payments/initiate-ussd-push-request         -> send the USSD prompt
//   GET  /payments/{orderReference}                   -> [payment, …] status by OUR reference
//
// Two differences from the old gateway shaped this file:
//
//   1. Auth is a short-lived bearer token minted from the client id + api key,
//      not a static header. The token is cached for ~55 minutes and minted once
//      for concurrent callers, so a burst of checkouts does not generate a
//      token per request (ClickPesa caps API calls per day before KYC).
//   2. WE choose the `orderReference` (alphanumeric, max 20 chars) and the
//      gateway echoes it; there is no gateway-assigned order id to store. That
//      reference IS the providerRef the webhook and the status poll match on.
//      Webhooks are configured in the ClickPesa dashboard (no per-request
//      webhook_url), verified by a checksum or a shared token — see
//      lib/webhook-auth.ts.
// =============================================================================

import config from "../config";
import { createBoundedCaller } from "../bounded-caller";
import { reportCredentialFault } from "../credential-alert";

// =============================================================================
// Types
// =============================================================================

export interface ClickPesaCollectRequest {
  /** Normalized MSISDN: 255712345678 (no +, no leading 0). */
  phone: string;
  /** TZS, min 100. */
  amount: number;
  /** Alphanumeric, max 20 chars. Unique per attempt — the gateway refuses a reuse. */
  orderReference: string;
}

export interface ClickPesaCollectResponse {
  success: boolean;
  /** Our order reference, echoed by the gateway. Stored as providerRef. */
  orderReference?: string;
  /** ClickPesa's own transaction id (diagnostics only). */
  transactionId?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface ClickPesaPayment {
  id?: string;
  /** SUCCESS | SETTLED | PROCESSING | PENDING | FAILED | ON-HOLD | REFUNDED | REVERSED */
  status: string;
  paymentReference?: string;
  orderReference?: string;
  collectedAmount?: number;
  collectedCurrency?: string;
  message?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface ClickPesaStatusResponse {
  success: boolean;
  payment?: ClickPesaPayment;
  error?: string;
}

/** The envelope ClickPesa POSTs to the webhook URL configured in its dashboard. */
export interface ClickPesaWebhookPayload {
  event: string; // "PAYMENT RECEIVED" | "PAYMENT FAILED" | "DEPOSIT RECEIVED" | …
  data: {
    id?: string;
    status?: string;
    paymentReference?: string;
    orderReference?: string;
    collectedAmount?: string | number;
    collectedCurrency?: string;
    message?: string;
    channel?: string;
    updatedAt?: string;
    createdAt?: string;
  };
  /** Optional HMAC-SHA256 signature, set when checksum signing is enabled. */
  checksum?: string;
  checksumMethod?: string;
}

// =============================================================================
// Shared fetch wrapper (auth + bound + breaker)
//
// The same rule as the gateway this replaced: a gateway that accepts the
// connection and then never answers is not one slow call, it is every call for
// the life of the process — and the reconcile sweep is the worst of them,
// because it calls once per pending charge. So the bound is paired with a
// breaker, and a 4xx never counts toward opening it (a rejected phone number is
// the gateway working, not the gateway being down).
// =============================================================================

/** How long one gateway call may take before it is abandoned. */
const CLICKPESA_TIMEOUT_MS = 20_000;

/** Generated tokens live one hour; refresh comfortably before that. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * An HTTP answer from the gateway that is not 2xx.
 *
 * A class rather than a bare Error so the breaker can tell a business rejection
 * (4xx) from a connectivity fault (5xx). `clickpesaErrorReason` strips the
 * prefix to show the merchant what the gateway actually said.
 */
export class ClickPesaHttpError extends Error {
  status: number;

  constructor(path: string, status: number, detail: string) {
    super(`ClickPesa ${path} error ${status}: ${detail}`);
    this.name = "ClickPesaHttpError";
    this.status = status;
  }
}

const gatewayCall = createBoundedCaller({
  timeoutMs: CLICKPESA_TIMEOUT_MS,
  failuresToOpen: 2,
  openForMs: 30_000,
  // "Could we reach the gateway?" — a 4xx proves we could, so it is not counted.
  countsAsFailure: (error) =>
    !(error instanceof ClickPesaHttpError) || error.status >= 500,
  onFailure: ({ reason, failures, opened }) => {
    if (!opened) return;
    void reportCredentialFault({
      service: "ClickPesa",
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
      `ClickPesa has not answered its last calls, so this one was not sent. ` +
        `Give it a moment and try again (${path}).`
    );
  }

  if (outcome.reason === "timeout") {
    throw new Error(
      `ClickPesa ${path} timed out after ${CLICKPESA_TIMEOUT_MS / 1000}s — the gateway did not answer`
    );
  }

  throw thrown ?? new Error(`ClickPesa ${path} failed`);
}

/** The gateway breaker's live state, for diagnostics and tests. */
export function clickpesaGatewayState(now: number = Date.now()) {
  const state = gatewayCall.state();
  return { open: now < state.openUntil, ...state };
}

/**
 * The gateway breaker in words — one source of wording for the places an
 * operator meets it, so two screens cannot describe the same outage differently.
 *
 * Returns null while the breaker is closed, which is the normal state. It cannot
 * be the credentials: a rejected key answers immediately (a 4xx on
 * /generate-token), and only unanswered calls open the breaker.
 */
export function clickpesaBreakerNotice(
  state: { open: boolean; openUntil: number; failures: number } = clickpesaGatewayState(),
  now: number = Date.now()
): string | null {
  if (!state.open) return null;

  const resumeInSeconds = Math.max(1, Math.ceil((state.openUntil - now) / 1000));
  return (
    "ClickPesa has not answered its last calls, so this server is skipping gateway calls " +
    `for about ${resumeInSeconds}s (${state.failures} failure(s) in a row). ` +
    "The credentials are not the problem — a rejected key answers immediately; an unanswered " +
    "call does not. It retries on its own as soon as the window passes."
  );
}

// =============================================================================
// Authorization token — minted once, cached, refreshed on expiry
// =============================================================================

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let inFlightToken: Promise<string> | null = null;

function credentialsConfigured(): boolean {
  return Boolean(config.clickPesa.clientId && config.clickPesa.apiKey);
}

async function requestToken(): Promise<string> {
  const response = await fetch(`${config.clickPesa.baseUrl}/generate-token`, {
    method: "POST",
    headers: {
      "client-id": config.clickPesa.clientId,
      "api-key": config.clickPesa.apiKey,
    },
    signal: AbortSignal.timeout(CLICKPESA_TIMEOUT_MS),
    cache: "no-store",
  });

  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    message?: string;
    error?: string;
  };

  if (!response.ok || !data?.token) {
    // 401/403 is the one fault the breaker deliberately ignores (the gateway
    // answered, so it is not down) and exactly the one an operator has to fix.
    if (response.status === 401 || response.status === 403) {
      void reportCredentialFault({
        service: "ClickPesa",
        detail:
          `the gateway rejected CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY (HTTP ${response.status} ` +
          "on /generate-token) — collects are refused immediately, so this is the credentials, " +
          "not the network",
      });
    }
    throw new ClickPesaHttpError(
      "/generate-token",
      response.status,
      data?.message || data?.error || response.statusText
    );
  }

  return data.token;
}

/**
 * A valid bearer token, minted on demand and reused until it nears expiry.
 *
 * The token is "Bearer …" already (ClickPesa returns it prefixed), so it is sent
 * verbatim as the Authorization header. Concurrent callers share one in-flight
 * mint, so a burst of checkouts does not spend a token request each — which
 * matters because pre-KYC accounts are capped at 100 API calls a day.
 */
export async function clickpesaToken(): Promise<string> {
  if (!credentialsConfigured()) {
    throw new Error("CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY are not configured");
  }

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  if (!inFlightToken) {
    inFlightToken = runBounded("/generate-token", requestToken)
      .then((token) => {
        cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
        return token;
      })
      .finally(() => {
        inFlightToken = null;
      });
  }

  return inFlightToken;
}

/** Forget the cached token (after a 401, and between tests). */
export function resetClickPesaToken(): void {
  cachedToken = null;
}

/**
 * Pre-load a token, so tests (and any caller that already holds one) can skip
 * the /generate-token round trip. Defaults to a full TTL.
 */
export function seedClickPesaToken(token: string, ttlMs: number = TOKEN_TTL_MS): void {
  cachedToken = { token, expiresAt: Date.now() + ttlMs };
}

async function clickpesaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!credentialsConfigured()) {
    throw new Error("CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY are not configured");
  }

  const attempt = (token: string): Promise<T> =>
    runBounded(path, async () => {
      const response = await fetch(`${config.clickPesa.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(CLICKPESA_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          ...(init?.headers || {}),
        },
        cache: "no-store",
      });

      const data = (await response.json().catch(() => ({}))) as T & {
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new ClickPesaHttpError(
          path,
          response.status,
          data?.message || data?.error || response.statusText
        );
      }

      return data;
    });

  try {
    return await attempt(await clickpesaToken());
  } catch (error) {
    // A cached token can expire between issuance and use. One refresh-and-retry
    // turns that into a non-event; a second 401 is real and surfaces.
    if (error instanceof ClickPesaHttpError && error.status === 401) {
      resetClickPesaToken();
      return attempt(await clickpesaToken());
    }
    throw error;
  }
}

// =============================================================================
// 1. Collect — send the USSD push to the customer's phone
// =============================================================================

/** The USSD push response, per the ClickPesa API reference. */
interface ClickPesaInitiateResponse {
  id?: string;
  status?: string;
  channel?: string;
  orderReference?: string;
  collectedAmount?: string;
  collectedCurrency?: string;
  createdAt?: string;
  clientId?: string;
}

/**
 * Initiate a USSD push collection.
 *
 * Throws on failure (bad number, empty account, unreachable gateway) so caller
 * routes take their existing `catch` path and show the gateway's own reason via
 * `clickpesaErrorReason`. The response's `orderReference` is what the webhook
 * and the status poll match on; it is stored as the transaction's providerRef.
 */
export async function clickpesaCollect(
  request: ClickPesaCollectRequest
): Promise<ClickPesaCollectResponse> {
  const data = await clickpesaFetch<ClickPesaInitiateResponse>(
    "/payments/initiate-ussd-push-request",
    {
      method: "POST",
      body: JSON.stringify({
        // The API takes the amount as a string.
        amount: String(Math.round(request.amount)),
        currency: "TZS",
        orderReference: request.orderReference,
        phoneNumber: request.phone,
      }),
    }
  );

  return {
    success: true,
    orderReference: data.orderReference || request.orderReference,
    transactionId: data.id,
    status: data.status,
    message: "USSD push sent — approve it on your phone",
  };
}

// =============================================================================
// 2. Payment status by our order reference
// =============================================================================

export async function clickpesaStatus(
  orderReference: string
): Promise<ClickPesaStatusResponse> {
  // The endpoint answers with an ARRAY (normally one element). Normalized to the
  // `{ success, payment }` shape every caller already reads.
  const data = await clickpesaFetch<ClickPesaPayment[] | ClickPesaPayment>(
    `/payments/${encodeURIComponent(orderReference)}`
  );

  const payment = Array.isArray(data) ? data[0] : data;
  return payment && payment.status ? { success: true, payment } : { success: true };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * A Tanzanian MSISDN as ClickPesa wants it: country code, no plus, no trunk 0.
 * `0712345678` and `+255712345678` both become `255712345678`.
 */
export function normalizeTzPhoneMsisdn(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("255")) return digits;
  if (digits.startsWith("0")) return `255${digits.slice(1)}`;
  return digits;
}

/**
 * A unique, alphanumeric order reference the gateway accepts (max 20 chars).
 *
 * The database id is a 25-char cuid, and our own order ids carry `-`, so neither
 * can be used directly. This is deliberately short (18 chars) so any future
 * prefix cannot push it over the limit, and random enough that two checkouts
 * cannot collide — ClickPesa refuses a reused reference, which would otherwise
 * look like a payment that never started.
 */
export function clickpesaOrderReference(prefix: string = "CP"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 10).toUpperCase();
  const clean = prefix.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "CP";
  return `${clean}${stamp}${random}`.slice(0, 20);
}

/**
 * Map a ClickPesa status onto our internal verdict, or null while it is still
 * in flight. SUCCESS means "received", SETTLED means "settled to the merchant" —
 * both are the customer's money landing, so both settle the charge.
 */
export function clickpesaStatusToInternal(
  status: string
): "SUCCESS" | "FAILED" | null {
  const s = status.toLowerCase();
  if (s === "success" || s === "settled") return "SUCCESS";
  if (s === "failed") return "FAILED";
  return null;
}

// Human-readable failure reason.
// Our fetch wrapper prefixes thrown errors with "ClickPesa /path error 4xx: ".
// Strip that so the UI can show the merchant what the gateway actually said
// (e.g. "Invalid / unsupported phone number").
export function clickpesaErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^ClickPesa\s+\S+\s+error\s+\d+:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "gateway haijajibu";
}
