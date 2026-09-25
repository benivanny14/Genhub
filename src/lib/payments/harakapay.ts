// =============================================================================
// GENHUB - HarakaPay Integration (the only gateway)
// USSD push payments: the customer approves the charge on their own phone.
// Docs: POST /api/v1/collect, GET /api/v1/status/{order_id}, GET /api/v1/balance
// Auth: X-API-Key header on every request.
// =============================================================================

import config from "../config";
import { createBoundedCaller } from "../bounded-caller";
import { reportCredentialFault } from "../credential-alert";

// =============================================================================
// Types
// =============================================================================

export interface HarakaCollectRequest {
  phone: string; // 0712345678
  amount: number; // TZS, min 100
  description?: string;
  webhookUrl?: string;
}

export interface HarakaCollectResponse {
  success: boolean;
  message?: string;
  order_id?: string;
  amount?: number;
  net_amount?: number;
  fee?: number;
  error?: string;
}

export interface HarakaPayment {
  order_id: string;
  status: string; // completed | failed | pending | ...
  amount: number;
  net_amount: number;
  fee_amount: number;
  created_at: string;
  completed_at?: string | null;
}

export interface HarakaStatusResponse {
  success: boolean;
  payment?: HarakaPayment;
  error?: string;
}

export interface HarakaBalanceResponse {
  success: boolean;
  wallet_balance?: number;
  float_balance?: number;
  error?: string;
}

// =============================================================================
// Shared fetch wrapper (auth header + bound + breaker)
//
// HarakaPay used to have only a per-call timeout, which is half the fix: a
// gateway that accepts the connection and then never answers is not one slow
// call, it is every call for the life of the process. `harakaStatus` is the
// worst of them — the reconcile sweep calls it once per pending charge, so a
// hung gateway turned a sweep that should take a second into minutes of
// sequential 20s waits, and the checkout poll made a customer watch a spinner
// that never moved.
//
// So the bound is paired with a breaker, exactly like Redis. What is different
// is failure classification: a 4xx is the gateway *working* ("Invalid mobile
// number"), so it must never count toward opening the breaker — one customer's
// typo would otherwise pause payments for everybody.
// =============================================================================

/**
 * How long one gateway call may take before it is abandoned.
 *
 * 20s because a USSD collect is a real round trip to the operator; status and
 * balance answer in far less. It is deliberately the same number as the socket
 * abort below, so the caller and the transport give up together.
 */
const HARAKA_TIMEOUT_MS = 20_000;

/**
 * An HTTP answer from the gateway that is not 2xx.
 *
 * A class rather than a bare Error so the breaker can tell a business rejection
 * (4xx) from a connectivity fault (5xx). The message keeps its exact shape —
 * `harakaErrorReason` strips the prefix to show the merchant what the gateway
 * actually said — so this is additive, not a change of contract.
 */
export class HarakaHttpError extends Error {
  status: number;

  constructor(path: string, status: number, detail: string) {
    super(`HarakaPay ${path} error ${status}: ${detail}`);
    this.name = "HarakaHttpError";
    this.status = status;
  }
}

/**
 * Every gateway call, bounded and breaker-guarded.
 *
 * Two failures in a row open the breaker for 30s, so a *third* caller is refused
 * at once instead of paying the wait again. The window is short on purpose: a
 * payment must not be refused for long, and one success closes the breaker, so
 * a recovered gateway resumes immediately.
 */
const gatewayCall = createBoundedCaller({
  timeoutMs: HARAKA_TIMEOUT_MS,
  failuresToOpen: 2,
  openForMs: 30_000,
  // "Could we reach the gateway?" — a 4xx proves we could, so it is not counted.
  countsAsFailure: (error) =>
    !(error instanceof HarakaHttpError) || error.status >= 500,
  // Announced only when the breaker trips — two calls in a row unanswered. A
  // single slow collect is not news; a gateway that has stopped answering is,
  // and waiting for the hourly watchdog to notice means up to an hour of
  // collects nobody will ever deliver.
  onFailure: ({ reason, failures, opened }) => {
    if (!opened) return;
    void reportCredentialFault({
      service: "HarakaPay",
      detail:
        `the gateway stopped answering (${failures} failure(s) in a row, last one ${reason}) ` +
        "— collect and status calls are being skipped; payments are not reaching handsets",
    });
  },
});

/** The gateway breaker's live state, for diagnostics and tests. */
export function harakaGatewayState(now: number = Date.now()) {
  const state = gatewayCall.state();
  return { open: now < state.openUntil, ...state };
}

/**
 * The gateway breaker in words — one source of wording for the two places an
 * operator meets it (`GET /api/payments/health` and the admin System readiness
 * probe), so the two cannot describe the same outage differently.
 *
 * Returns null while the breaker is closed, which is the normal state. The
 * wording matters: an operator staring at a failed balance call needs to know
 * the key is fine, because "the gateway is not answering" and "your key was
 * rejected" look identical from the outside and only one of them is fixable in
 * the HarakaPay dashboard. It cannot be the key: a rejected key answers
 * immediately (a 4xx), and only unanswered calls open the breaker.
 */
export function harakaBreakerNotice(
  state: { open: boolean; openUntil: number; failures: number } = harakaGatewayState(),
  now: number = Date.now()
): string | null {
  if (!state.open) return null;

  const resumeInSeconds = Math.max(1, Math.ceil((state.openUntil - now) / 1000));
  return (
    "HarakaPay has not answered its last calls, so this server is skipping gateway calls " +
    `for about ${resumeInSeconds}s (${state.failures} failure(s) in a row). ` +
    "The API key is not the problem — a rejected key answers immediately; an unanswered " +
    "call does not. It retries on its own as soon as the window passes."
  );
}

async function harakaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config.harakaPay.apiKey) {
    throw new Error("HARAKAPAY_API_KEY is not configured");
  }

  // The breaker only reports a reason, so the original error is remembered here.
  // Callers — and `harakaErrorReason`, which shows the gateway's own words —
  // need the message, not just "the call failed".
  let thrown: unknown = null;

  const outcome = await gatewayCall.run(async () => {
    try {
      const response = await fetch(`${config.harakaPay.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(HARAKA_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": config.harakaPay.apiKey,
          ...(init?.headers || {}),
        },
        cache: "no-store",
      });

      const data = (await response.json().catch(() => ({}))) as T & {
        success?: boolean;
        error?: string;
      };

      if (!response.ok) {
        // A 401/403 is the one fault the breaker deliberately ignores — the
        // gateway answered, so it is not down — and it is exactly the one an
        // operator has to fix: a rotated, revoked or wrong API key. It would
        // otherwise only surface when somebody opened the admin panel.
        if (response.status === 401 || response.status === 403) {
          void reportCredentialFault({
            service: "HarakaPay",
            detail:
              `the gateway rejected HARAKAPAY_API_KEY (HTTP ${response.status} on ${path}) ` +
              "— collects are refused immediately, so this is the key, not the network",
          });
        }
        throw new HarakaHttpError(
          path,
          response.status,
          data?.error || response.statusText
        );
      }

      return data;
    } catch (error) {
      thrown = error;
      throw error;
    }
  });

  if (outcome.ok) return outcome.value;

  if (outcome.reason === "open") {
    throw new Error(
      `HarakaPay has not answered its last calls, so this one was not sent. ` +
        `Give it a moment and try again (${path}).`
    );
  }

  if (outcome.reason === "timeout") {
    throw new Error(
      `HarakaPay ${path} timed out after ${HARAKA_TIMEOUT_MS / 1000}s — the gateway did not answer`
    );
  }

  throw thrown ?? new Error(`HarakaPay ${path} failed`);
}

// =============================================================================
// 1. Collect payment (USSD push to the customer's phone)
// =============================================================================

export async function harakaCollect(
  request: HarakaCollectRequest
): Promise<HarakaCollectResponse> {
  return harakaFetch<HarakaCollectResponse>("/api/v1/collect", {
    method: "POST",
    body: JSON.stringify({
      phone: request.phone,
      amount: request.amount,
      description: request.description || "",
      ...(request.webhookUrl ? { webhook_url: request.webhookUrl } : {}),
    }),
  });
}

// =============================================================================
// 2. Payment status by HarakaPay order_id
// =============================================================================

export async function harakaStatus(
  orderId: string
): Promise<HarakaStatusResponse> {
  return harakaFetch<HarakaStatusResponse>(
    `/api/v1/status/${encodeURIComponent(orderId)}`
  );
}

// =============================================================================
// 3. Wallet balance
// =============================================================================

export async function harakaBalance(): Promise<HarakaBalanceResponse> {
  return harakaFetch<HarakaBalanceResponse>("/api/v1/balance");
}

// =============================================================================
// Webhook helpers
// =============================================================================

// Payload shape posted by HarakaPay to our webhook_url
export interface HarakaWebhookPayload {
  order_id: string;
  status: string; // "completed" | "failed"
  amount: number;
  net_amount: number;
  fee_amount: number;
  created_at: string;
  completed_at?: string | null;
}

// =============================================================================
// Human-readable failure reason
// =============================================================================
// Our fetch wrapper prefixes thrown errors with "HarakaPay /path error 4xx: ".
// Strip that so the UI can show the merchant what the gateway actually said
// (e.g. "insufficient balance", "invalid phone number").
export function harakaErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^HarakaPay\s+\S+\s+error\s+\d+:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "gateway haijajibu";
}

export function harakaStatusToInternal(
  status: string
): "SUCCESS" | "FAILED" | null {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success") return "SUCCESS";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "FAILED";
  return null;
}
