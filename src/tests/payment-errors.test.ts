// =============================================================================
// GENHUB - The three things a payment screen may say
//
// The rule that matters most: a code where a prompt may already be waiting on
// the customer's phone must NEVER be rendered as "nothing was charged, try
// again" — that is the one misclassification that charges a person twice.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  outcomeForFailure,
  outcomeForStatus,
  outcomeForApiError,
} from "@/lib/payment-errors";

describe("outcomeForFailure", () => {
  it("never invites a retry while a prompt may be waiting", () => {
    for (const code of ["PENDING_PAYMENT", "ALREADY_PAID", "UNDER_INVESTIGATION"]) {
      const outcome = outcomeForFailure({ code });
      expect(outcome.retry, `${code} must not invite a retry`).toBe(false);
    }
  });

  it("treats a duplicate checkout as already waiting on the phone", () => {
    const outcome = outcomeForFailure({ code: "PENDING_PAYMENT" });
    expect(outcome.kind).toBe("check-phone");
    expect(outcome.body.toLowerCase()).toContain("do not pay twice");
  });

  it("reads a settled duplicate as already paid, not an error", () => {
    const outcome = outcomeForFailure({ code: "ALREADY_PAID" });
    expect(outcome.kind).toBe("settled");
    expect(outcome.tone).toBe("success");
  });

  it("says nothing was charged for an upstream outage of ours", () => {
    for (const code of ["TEMPORARILY_UNAVAILABLE", "CHECKOUT_PAUSED", "GATEWAY_ERROR"]) {
      const outcome = outcomeForFailure({ code });
      expect(outcome.kind).toBe("not-charged");
      expect(outcome.body).toContain("Nothing has been charged");
      expect(outcome.retry).toBe(true);
    }
  });

  it("refuses a retry when the request itself was wrong", () => {
    for (const code of ["AMOUNT_MISMATCH", "INSUFFICIENT_WALLET", "VIDEO_PROCESSING"]) {
      const outcome = outcomeForFailure({ code });
      expect(outcome.kind).toBe("not-now");
      expect(outcome.retry).toBe(false);
    }
  });

  it("defaults an unknown code to nothing-charged and safe to retry", () => {
    const outcome = outcomeForFailure({ code: "SOMETHING_NEW" });
    expect(outcome.kind).toBe("not-charged");
    expect(outcome.retry).toBe(true);
  });

  it("treats a 5xx with no code as ours, not the customer's", () => {
    expect(outcomeForFailure({ status: 500 }).tone).toBe("error");
    expect(outcomeForFailure({ status: 400 }).tone).toBe("warning");
  });
});

describe("outcomeForStatus", () => {
  it("confirms success", () => {
    expect(outcomeForStatus("SUCCESS").kind).toBe("settled");
  });

  it("stops a customer paying again while under investigation", () => {
    const outcome = outcomeForStatus("UNDER_INVESTIGATION");
    expect(outcome.kind).toBe("check-phone");
    expect(outcome.retry).toBe(false);
    expect(outcome.body).toContain("Please do not pay again");
  });

  it("treats a cancelled charge as nothing charged", () => {
    const outcome = outcomeForStatus("CANCELLED");
    expect(outcome.kind).toBe("not-charged");
    expect(outcome.retry).toBe(true);
  });
});

describe("outcomeForApiError", () => {
  it("prefers the server's specific sentence, and keeps our safety flags", () => {
    const outcome = outcomeForApiError({
      error: "This video costs TZS 2,000.",
      code: "AMOUNT_MISMATCH",
    });
    expect(outcome.body).toBe("This video costs TZS 2,000.");
    expect(outcome.retry).toBe(false);
  });

  it("does not let a server sentence turn a waiting prompt into a retry", () => {
    const outcome = outcomeForApiError({
      error: "A payment is still pending.",
      code: "PENDING_PAYMENT",
    });
    expect(outcome.kind).toBe("check-phone");
    expect(outcome.retry).toBe(false);
  });
});
