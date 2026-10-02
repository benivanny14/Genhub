// =============================================================================
// GENHUB - What a payment screen is allowed to say
//
// A checkout can fail in ways a customer cannot tell apart, and one of them
// costs money twice. Three questions have to be answered, and only one answer
// per screen:
//
//   1. "Nothing was charged" — the attempt never reached the network, or was
//      refused before any prompt was sent. The customer may safely try again.
//   2. "Check your phone" — a prompt IS on its way. The money may move if they
//      approve it, so retrying now is what creates a double charge.
//   3. "Not you / not now" — the request itself was wrong (the wrong price, an
//      expired coupon, an empty wallet, a scene still transcoding). Nothing was
//      charged, and repeating the identical request will not help.
//
// Those are the only three. This module is the single mapping from an API error
// `code` (see lib/api-response.ts) or a polled transaction status onto them, so
// the paywall, the wallet and the payments page cannot describe the same failure
// three different ways — and so that `PENDING_PAYMENT`, the one code where a
// second attempt is genuinely dangerous, is never rendered as a plain "try
// again".
// =============================================================================

/** The three answers a payment screen may give, plus the settled one. */
export type PaymentOutcomeKind = "not-charged" | "check-phone" | "not-now" | "settled";

export interface PaymentOutcome {
  kind: PaymentOutcomeKind;
  /** Short heading for the panel. */
  title: string;
  /** One sentence the customer can act on. */
  body: string;
  /** Which toast colour to use. */
  tone: "error" | "warning" | "info" | "success";
  /**
   * True only when repeating the same request is safe because we know no money
   * moved. `check-phone` and `settled` are false: the screen must not invite a
   * retry that could charge twice.
   */
  retry: boolean;
}

/**
 * API error codes where a prompt may already be waiting on the customer's phone.
 * Paying again here is the exact mistake this module exists to prevent.
 */
const PROMPT_ALREADY_SENT = [
  "PENDING_PAYMENT",
  "ALREADY_PAID",
  "UNDER_INVESTIGATION",
] as const;

/**
 * Codes that mean "we could not reach or start the charge" — the money did not
 * move, and trying again shortly is the right advice.
 */
const NOT_CHARGED_CODES = [
  "TEMPORARILY_UNAVAILABLE",
  "CHECKOUT_PAUSED",
  "GATEWAY_ERROR",
  "GATEWAY_REJECTED",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
] as const;

/** Codes where the request was wrong and repeating it changes nothing. */
const NOT_NOW_CODES = [
  "AMOUNT_MISMATCH",
  "INVALID_COUPON",
  "COUPON_COVERS_TOTAL",
  "INSUFFICIENT_WALLET",
  "FREE_VIDEO",
  "VIDEO_PROCESSING",
  "VIDEO_UNAVAILABLE",
  "SPEND_CAP",
  "VALIDATION_ERROR",
] as const;

/** The same three answers for a polled transaction status. */
export function outcomeForStatus(status: string): PaymentOutcome {
  switch (status) {
    case "SUCCESS":
      return {
        kind: "settled",
        title: "Payment confirmed",
        body: "You are unlocked — enjoy the full video.",
        tone: "success",
        retry: false,
      };
    case "UNDER_INVESTIGATION":
      return {
        kind: "check-phone",
        title: "We are checking with your network",
        body: "You approved the charge but the money has not reached us yet. Please do not pay again — we will settle it shortly.",
        tone: "warning",
        retry: false,
      };
    case "PENDING":
      return {
        kind: "check-phone",
        title: "Waiting for your approval",
        body: "A prompt was sent to your phone. Enter your PIN to confirm — do not start another payment.",
        tone: "info",
        retry: false,
      };
    case "FAILED":
    case "CANCELLED":
    case "EXPIRED":
      return {
        kind: "not-charged",
        title: "Payment was not completed",
        body: "The charge did not go through, so nothing was deducted. You can try again.",
        tone: "error",
        retry: true,
      };
    default:
      return {
        kind: "not-charged",
        title: "Payment status unknown",
        body: "We could not read the status of this payment. Nothing has been charged so far — check your phone before trying again.",
        tone: "warning",
        retry: false,
      };
  }
}

export interface PaymentFailureInput {
  /** Machine code from the API body, when present. */
  code?: string | null;
  /** HTTP status, used when no code is present (a 5xx is always ours). */
  status?: number;
}

/**
 * The three kinds, chosen from an API error. Unknown codes default to
 * "not-charged", because a failure we cannot classify is far more likely to be a
 * refusal we never logged than a silent charge — and telling a customer to check
 * their phone for a charge that does not exist is its own kind of harm.
 */
export function outcomeForFailure(input: PaymentFailureInput): PaymentOutcome {
  const code = (input.code || "").toUpperCase();

  if ((PROMPT_ALREADY_SENT as readonly string[]).includes(code)) {
    if (code === "ALREADY_PAID") {
      return {
        kind: "settled",
        title: "This is already paid",
        body: "Your payment already completed — refresh the page to unlock the video.",
        tone: "success",
        retry: false,
      };
    }
    return {
      kind: "check-phone",
      title: "A payment is already waiting",
      body: "We are still waiting on a charge you started. Complete it on your phone, or wait for it to expire, before trying again — do not pay twice.",
      tone: "warning",
      retry: false,
    };
  }

  if ((NOT_CHARGED_CODES as readonly string[]).includes(code)) {
    return {
      kind: "not-charged",
      title: "Payment could not start",
      body: "Nothing has been charged. Please try again in a moment.",
      tone: "error",
      retry: true,
    };
  }

  if ((NOT_NOW_CODES as readonly string[]).includes(code)) {
    return {
      kind: "not-now",
      title: "This payment cannot go through",
      body: "Nothing was charged. Adjust what the message says and try again.",
      tone: "warning",
      retry: false,
    };
  }

  // A 5xx with no code is still ours to fix; a 4xx is a request problem. Either
  // way no money moved yet.
  return {
    kind: "not-charged",
    title: "Payment was not started",
    body: "We could not start this payment. Nothing has been charged — please try again.",
    tone: input.status && input.status >= 500 ? "error" : "warning",
    retry: true,
  };
}

/**
 * Turn a failed fetch response body into one of the three answers. Returns the
 * server's own `error` sentence as `body` when it is more specific than ours,
 * because a validation message ("This video costs TZS 2,000") is the product,
 * while our generic lines are only for the cases the server did not explain.
 */
export function outcomeForApiError(data: {
  error?: string;
  code?: string;
  status?: number;
} | null): PaymentOutcome {
  const base = outcomeForFailure({ code: data?.code, status: data?.status });
  if (data?.error && (base.kind === "not-now" || base.kind === "not-charged")) {
    return { ...base, body: data.error };
  }
  return base;
}
