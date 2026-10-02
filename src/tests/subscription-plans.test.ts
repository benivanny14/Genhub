// =============================================================================
// GENHUB - Subscription plans (weekly / monthly / quarterly)
//
// The rule that matters: whatever a checkout charges, the period it grants has
// to match. A quarterly payment that grants one month is a refund waiting to
// happen; a weekly plan priced like a month is an overcharge.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_PRICE_TZS,
  planPrice,
  resolveSubscriptionPlan,
} from "@/lib/subscription";
import { nextRenewalDate } from "@/lib/services/subscription.service";

describe("resolveSubscriptionPlan", () => {
  it("knows the three plans", () => {
    expect(Object.keys(SUBSCRIPTION_PLANS).sort()).toEqual([
      "monthly",
      "quarterly",
      "weekly",
    ]);
  });

  it("falls back to monthly for anything unknown", () => {
    expect(resolveSubscriptionPlan("yearly").id).toBe("monthly");
    expect(resolveSubscriptionPlan(null).id).toBe("monthly");
    expect(resolveSubscriptionPlan(undefined).id).toBe("monthly");
  });
});

describe("planPrice", () => {
  it("charges a quarter of the monthly price for a week", () => {
    expect(planPrice(8_000, "weekly")).toBe(2_000);
  });

  it("discounts three months", () => {
    expect(planPrice(8_000, "quarterly")).toBe(20_000);
    expect(planPrice(8_000, "quarterly")).toBeLessThan(8_000 * 3);
  });

  it("leaves the monthly price untouched", () => {
    expect(planPrice(SUBSCRIPTION_PRICE_TZS, "monthly")).toBe(SUBSCRIPTION_PRICE_TZS);
  });

  it("never falls under the gateway's floor", () => {
    expect(planPrice(50, "weekly")).toBe(100);
  });
});

describe("nextRenewalDate", () => {
  const soon = new Date(Date.now() + 3 * 86_400_000); // active membership

  it("extends a weekly plan by seven days from the current expiry", () => {
    const next = nextRenewalDate(soon, 1, 7);
    const days = Math.round((next.getTime() - soon.getTime()) / 86_400_000);
    expect(days).toBe(7);
  });

  it("extends a quarterly plan by three calendar months", () => {
    const next = nextRenewalDate(soon, 3, 0);
    const months =
      (next.getFullYear() - soon.getFullYear()) * 12 + (next.getMonth() - soon.getMonth());
    expect(months).toBe(3);
  });

  it("keeps the default one month for existing callers", () => {
    const next = nextRenewalDate(soon);
    const months =
      (next.getFullYear() - soon.getFullYear()) * 12 + (next.getMonth() - soon.getMonth());
    expect(months).toBe(1);
  });

  it("starts from today once a membership has lapsed", () => {
    const past = new Date(Date.now() - 10 * 86_400_000);
    const next = nextRenewalDate(past, 1, 7);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
});
