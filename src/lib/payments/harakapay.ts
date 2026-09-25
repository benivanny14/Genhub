// =============================================================================
// GENHUB - HarakaPay Integration (the only gateway)
// USSD push payments: the customer approves the charge on their own phone.
// Docs: POST /api/v1/collect, GET /api/v1/status/{order_id}, GET /api/v1/balance
// Auth: X-API-Key header on every request.
// =============================================================================

import config from "../config";
import { cacheGet, cacheSet } from "../redis";
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
  // The float gate, first: see section 4. It throws before a single byte is sent
  // when the merchant account has nothing to deliver a prompt with, because a
  // collect that is accepted and never delivered is worse than a collect that is
  // refused — the first one tells the customer it worked.
  await assertFloatCanDeliver();

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
// 4. The float gate: can a USSD prompt actually be delivered?
// =============================================================================
// HarakaPay settles a USSD prompt out of a PREPAID FLOAT on the merchant
// account. At 0 the gateway does not refuse: it accepts the collect, answers
// "USSD push sent", and never delivers the prompt. The customer taps Pay on a
// screen that says it worked, their phone never rings, and the order sits
// PENDING forever while nobody was told anything.
//
// The alerting already exists (harakapay-float-alert.service.ts tells the admins
// on the way down). What did not exist was a refusal: the app kept selling. So
// this is the guard, at the ONE call every USSD push goes through, which is the
// only placement that a new route cannot bypass by forgetting to ask.
//
// Three decisions worth naming:
//
//   * BLOCK ONLY AT ZERO, not at the alert floor. The floor is where an operator
//     wants to be warned; the gateway still delivers prompts above zero, so
//     refusing a sale at the floor would turn a warning into lost revenue for a
//     payment that would have completed. "Empty" is the state that cannot work.
//
//   * FAIL OPEN WHEN THE BALANCE IS UNREADABLE, and say so. A balance endpoint
//     that will not answer is not knowledge that the float is empty, and blocking
//     every payment on a reading we could not take would convert a gateway blip
//     into an outage of our own making. The collect is the authoritative test:
//     if it succeeds, there was float behind it. The unreadable case is reported
//     by the watch that already logs it (`[Float Watch]`), surfaced in
//     /api/payments/health, and does not pretend to be a decision here.
//
//   * ONE READING A MINUTE, not one per checkout. The answer is cached for
//     FLOAT_CACHE_MS, so a busy minute costs one balance call instead of one per
//     customer — and recovery is never more than a minute away, which is why an
//     operator who tops up the float sees sales resume on their own.
//
// It is deliberately NOT consulted in sandbox mode: PAYMENT_SANDBOX=true means
// "no gateway call at all", and a guard that phoned the live gateway to ask about
// a float would break that promise in development.
// =============================================================================

/** How long one balance reading is trusted. Short, because it gates real money. */
export const FLOAT_CACHE_MS = 60_000;

/** Where the cached reading lives. Versioned: a shape change must not be read as the old one. */
export const FLOAT_GATE_CACHE_KEY = "harakapay:float-gate:v1";

/**
 * The words a customer sees when a collect is refused.
 *
 * One string, shared by every checkout route, so three screens cannot describe
 * the same outage three ways. What it says is deliberately narrow: this is
 * temporarily unavailable, and you have NOT been charged. The second half is the
 * one that matters — a customer who cannot tell whether the tap cost them money
 * either pays again, or opens a support ticket, or both.
 *
 * "Nothing was sent to your phone" is the one claim that is true by
 * construction rather than by diagnosis: the guard refuses *before* the collect,
 * so the charge provably never left this server. It is also why the sentence does
 * not name the mechanism ("the prompt cannot reach your phone") — the float is
 * documented as paying for the prompt in some accounts and for settlement in
 * others (§3.1 of PRODUCTION.md describes both symptoms), and a customer-facing
 * claim should not be the half of that we are less sure about.
 *
 * What it does NOT say is equally deliberate. Not why: the state of the merchant
 * account is ours to fix, not a stranger's to read, and "the float is empty" is
 * a sentence about our cash position. Not "try again in a few minutes" as though
 * a retry were the fix, because an unfunded account may stay that way for hours.
 * And not a wallet pitch: the two checkouts that have a wallet fallback say so
 * themselves (the top-up screen has none — telling somebody topping up their
 * wallet to pay from their wallet is how a clear message reads as a misfire).
 */
export const FLOAT_EMPTY_CUSTOMER_MESSAGE =
  "Mobile-money payments are temporarily unavailable: we cannot start the USSD charge " +
  "right now, so nothing was sent to your phone and you have NOT been charged. " +
  "Please try again shortly.";

/**
 * The refusal, as a type.
 *
 * A class rather than a message so callers branch on the FACT and not on the
 * wording: the checkout routes answer 503 with the code below, and the renewal
 * worker must skip the attempt entirely rather than record a failure against a
 * subscribing customer for a fault that is entirely ours.
 */
export class HarakaFloatEmptyError extends Error {
  readonly code = "GATEWAY_FLOAT_EMPTY";
  /** 503, not 502: the gateway is fine, we are temporarily unable to sell. */
  readonly status = 503;
  readonly floatTzs: number;

  constructor(floatTzs: number) {
    super(FLOAT_EMPTY_CUSTOMER_MESSAGE);
    this.name = "HarakaFloatEmptyError";
    this.floatTzs = floatTzs;
  }
}

/** What one look at the float concluded. */
export type FloatGateState = "ok" | "empty" | "unknown";

/**
 * The decision itself, from a balance we may or may not have read.
 *
 * Pure, so the boundary is pinned by a test instead of discovered by a customer:
 * a positive float is `ok`, zero (or a negative one, which some gateways report
 * after a correction) is `empty`, and anything that is not a number at all is
 * `unknown` — never `empty`, because "we could not read it" must not refuse a
 * payment that may be perfectly payable.
 */
export function floatGateState(floatTzs: number | null | undefined): FloatGateState {
  if (typeof floatTzs !== "number" || !Number.isFinite(floatTzs)) return "unknown";
  return floatTzs > 0 ? "ok" : "empty";
}

/**
 * True when a REAL collect is what the caller is about to attempt.
 *
 * The same condition the checkout routes use to decide between sandbox and a
 * live push: in development with PAYMENT_SANDBOX on (or with no key at all) no
 * USSD push is sent, so there is no float to consult and this guard must not
 * reach for the network.
 */
export function floatGateApplies(): boolean {
  const sandboxMode =
    config.nodeEnv !== "production" &&
    (!config.harakaPay.apiKey || config.harakaPay.sandbox);
  return Boolean(config.harakaPay.apiKey) && !sandboxMode;
}

export interface FloatGate {
  state: FloatGateState;
  /** The float the last reading saw, when it saw one. */
  floatTzs: number | null;
  /** True when this answer came from the cache rather than the gateway. */
  cached: boolean;
}

/**
 * Ask whether the float can deliver a prompt, from cache when there is one.
 *
 * Never throws: every failure to read becomes `unknown`, which is a state the
 * caller is allowed to sell in. That is what keeps a balance endpoint that is
 * down from stopping payments twice over.
 */
export async function floatGate(): Promise<FloatGate> {
  if (!floatGateApplies()) return { state: "ok", floatTzs: null, cached: false };

  const cached = await cacheGet<FloatGate>(FLOAT_GATE_CACHE_KEY);
  if (cached && (cached.state === "ok" || cached.state === "empty" || cached.state === "unknown")) {
    return { ...cached, cached: true };
  }

  let reading: FloatGate;
  try {
    const body = await harakaBalance();
    const raw = body?.float_balance;
    const floatTzs =
      raw === null || raw === undefined || !Number.isFinite(Number(raw))
        ? null
        : Number(raw);

    reading = { state: floatGateState(floatTzs), floatTzs, cached: false };
  } catch (error) {
    // Named, not swallowed: this is the difference between "the float is fine"
    // and "we do not know", and only one of them is a fact.
    reading = { state: "unknown", floatTzs: null, cached: false };
    console.warn(
      `[Float Gate] could not read the gateway float, so payments are being attempted: ` +
        `${harakaErrorReason(error)}`
    );
  }

  // Cached whatever the answer was, `unknown` included: the decision it leads to
  // is identical to the one an immediate re-read would produce, so a broken
  // balance endpoint must not cost a gateway call on every single checkout.
  await cacheSet(FLOAT_GATE_CACHE_KEY, reading, Math.ceil(FLOAT_CACHE_MS / 1000));
  return reading;
}

/**
 * Throw when the float cannot deliver a prompt.
 *
 * The whole guard, in one function, called by `harakaCollect` and by nothing
 * else — so there is exactly one place that decides whether money may be asked
 * for, and a new checkout route inherits it by calling the gateway the way every
 * other route does.
 */
export async function assertFloatCanDeliver(): Promise<void> {
  const gate = await floatGate();
  if (gate.state === "empty") {
    console.warn(
      "[Float Gate] refused a collect: the HarakaPay float is empty, so the " +
        "prompt would never be delivered. Top up the merchant float."
    );
    throw new HarakaFloatEmptyError(gate.floatTzs ?? 0);
  }
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
