// =============================================================================
// GENHUB - What a gateway refusal means, and who it is about
//
// SonicPesa answers a refused collect with its own words, and the routes used to
// hand those words straight to the customer. Most of the time that is right:
// "Insufficient funds in your Halopesa account. Please top up and try again." is
// the single most useful sentence the checkout can print.
//
// It is wrong for one class of refusal. When the fault is OUR merchant account —
// the daily API cap, an unfinished KYC, an account that is not activated — the
// customer reads a message about a problem they cannot see, cannot fix, and did
// not cause. Measured on this deployment: a full day of failed checkouts, every
// one of them answered with
//
//   "Daily API limit reached. Complete your KYC to remove this limit."
//
// to a fan who was trying to buy a video. Nothing was charged, the money path was
// fine, and the only thing broken was our own account setup — reported to the
// wrong person, in the wrong voice, with no way to act on it.
//
// So a refusal is classified before it is shown:
//
//   * customer      the gateway said something about THIS payment (funds, PIN,
//                   a number it will not accept). Passed through verbatim — this
//                   is the product, and softening it would only hide the fix.
//   * account-limit OUR cap was reached. The customer gets a plain "it is us,
//                   try later, nothing was charged" and the operator gets the
//                   gateway's own sentence in the log.
//   * account-setup OUR account is not ready to collect. Same split.
//   * unreachable   the gateway did not answer (our timeout, our breaker). Never
//                   the customer's fault, and our own text must not leak out.
//
// The rule in one line: a customer may always be told what to do about THEIR
// payment, and never about ours.
// =============================================================================

import { api } from "./api-response";

/** Which of the four a refusal is. */
export type GatewayFaultKind = "customer" | "account-limit" | "account-setup" | "unreachable";

export interface GatewayFailure {
  kind: GatewayFaultKind;
  /** Machine code for the client — see lib/payment-errors.ts. */
  code: string;
  /** HTTP status the route answers with. */
  status: number;
  /** What the CUSTOMER reads. For `customer` faults this is the gateway's own words. */
  message: string;
  /** What the OPERATOR needs. Never sent — it goes to the log with the reference. */
  gatewayMessage: string;
}

/**
 * Faults that belong to our merchant account rather than to this payment.
 *
 * Deliberately narrow and explicit. The tempting shortcut — "does the message
 * mention KYC or funds?" — would swallow "Insufficient funds in your Halopesa
 * account", which is the customer's own money and the one thing they can act on.
 * Every pattern below names our side of the counter.
 */
const MERCHANT_FAULTS: { pattern: RegExp; kind: GatewayFaultKind }[] = [
  // The daily API cap. Pre-KYC accounts are limited to 100 calls a day, and a
  // busy day exhausts it — after which every checkout fails identically until
  // midnight, no matter whose phone is asking.
  {
    pattern: /daily api limit|api limit reached|\b100 calls per day\b|api calls? per day/i,
    kind: "account-limit",
  },
  // The account itself is not finished: KYC outstanding, not yet activated.
  {
    pattern:
      /complete your kyc|kyc (is )?(not|incomplete|pending)|account is not (yet )?activated|merchant account (is )?(not )?(active|activated|verified)/i,
    kind: "account-setup",
  },
];

/**
 * Our own gateway-bound text: the breaker refusing to send, or the timeout.
 *
 * These are written for an operator reading a log, and they name the gateway and
 * the internals, so they are classified rather than forwarded.
 */
const UNREACHABLE_PATTERN =
  /has not answered its last calls|was not sent|timed out after|gateway did not answer|not configured/i;

/**
 * Classify a refusal into one of the four kinds.
 *
 * `raw` is either the gateway's own rejection message or the reason our fetch
 * wrapper produced (which preserves the gateway's words for an HTTP error, and
 * our own for a timeout or an open breaker).
 */
export function classifyGatewayFailure(raw: string | null | undefined): GatewayFailure {
  const gatewayMessage = (raw || "").trim();

  // Unreachable first: our own timeout text can contain the word "gateway", and
  // it must never be mistaken for something the gateway said.
  if (UNREACHABLE_PATTERN.test(gatewayMessage)) {
    return {
      kind: "unreachable",
      code: "GATEWAY_ERROR",
      status: 502,
      message:
        "We could not start the payment just now. Nothing has been charged — please try again.",
      gatewayMessage,
    };
  }

  for (const { pattern, kind } of MERCHANT_FAULTS) {
    if (pattern.test(gatewayMessage)) {
      return {
        kind,
        code: "TEMPORARILY_UNAVAILABLE",
        status: 503,
        // About the customer's money, not about our cap: nothing was charged and
        // waiting is the only correct advice. "Try again in a moment" would be a
        // lie when the cap clears at midnight.
        message:
          "Mobile-money payments are temporarily unavailable on our side. Nothing has been charged — please try again a little later, or pay from your wallet.",
        gatewayMessage,
      };
    }
  }

  return {
    kind: "customer",
    code: "GATEWAY_REJECTED",
    status: 502,
    // The gateway's own sentence, which is the most specific thing anybody can
    // say about this particular attempt.
    message: gatewayMessage || "The payment was refused. Please check your details and try again.",
    gatewayMessage,
  };
}

/**
 * The response for a failed collect, from the classification.
 *
 * Two halves, and they never swap places: a `customer` refusal is answered with
 * the gateway's own words (a 4xx-shaped business answer), and everything else is
 * answered with a plain sentence plus a reference, with the gateway's message and
 * the transaction id going to the log only.
 */
export function gatewayFailureResponse(params: {
  failure: GatewayFailure;
  context: string;
  transactionId: string;
}) {
  const { failure, context, transactionId } = params;

  if (failure.kind === "customer") {
    return api.error(failure.message, failure.status, failure.code);
  }

  return api.upstream(`collect failed for transaction ${transactionId}: ${failure.gatewayMessage}`, {
    context,
    status: failure.status,
    code: failure.code,
    message: failure.message,
  });
}
