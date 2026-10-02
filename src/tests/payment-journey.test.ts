// =============================================================================
// GENHUB - The journey of one charge: what the customer was shown
//
// The admin Payments panel shows an operator "what the customer saw" for a
// charge. That sentence is derived in ONE pure place so a support script and the
// panel cannot describe the same state two ways. These cases pin each state,
// including the two that are easy to get wrong: an EXPIRED checkout (safe to
// retry) is deliberately different from a gateway failure, and an
// UNDER_INVESTIGATION charge must say "do not pay again".
//
// Only the pure function is exercised — no database.
// =============================================================================

import { describe, it, expect } from "vitest";
import { describeCustomerExperience } from "@/lib/services/payment-journey.service";

describe("describeCustomerExperience", () => {
  it("says the wallet was credited for a settled top-up", () => {
    expect(
      describeCustomerExperience({ status: "SUCCESS", type: "WALLET_TOPUP", metadata: null })
    ).toMatch(/Wallet credited/);
  });

  it("says access was unlocked for a settled purchase", () => {
    expect(
      describeCustomerExperience({ status: "SUCCESS", type: "PPV_PURCHASE", metadata: null })
    ).toMatch(/Access unlocked/);
  });

  it("tells the customer NOT to pay again while under investigation", () => {
    expect(
      describeCustomerExperience({
        status: "UNDER_INVESTIGATION",
        type: "PPV_PURCHASE",
        metadata: { investigation: true },
      })
    ).toMatch(/do not pay again/i);
  });

  it("invites the customer to check their phone while a charge is pending", () => {
    expect(
      describeCustomerExperience({ status: "PENDING", type: "PPV_PURCHASE", metadata: null })
    ).toMatch(/Check your phone/);
  });

  it("tells the customer an expired checkout is safe to retry, not that it failed", () => {
    const message = describeCustomerExperience({
      status: "FAILED",
      type: "PPV_PURCHASE",
      metadata: { expired: true },
    });
    expect(message).toMatch(/expired/);
    expect(message).toMatch(/safely try again/);
  });

  it("tells the customer nothing was charged when the checkout could not start", () => {
    expect(
      describeCustomerExperience({
        status: "FAILED",
        type: "PPV_PURCHASE",
        metadata: { gatewayError: "insufficient balance" },
      })
    ).toMatch(/Nothing has been charged/);
  });
});
