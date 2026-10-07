// =============================================================================
// GENHUB - src/lib/payout-attention.ts
//
// The queue tells an admin three things about a withdrawal: how long it has been
// waiting, where it is, and what to do next. Every one of those has a failure
// that looks like success:
//
//   1. A PENDING request under the gateway's floor must NOT be advised as
//      "approve it and it will send" — the gateway refuses that amount, and an
//      admin who presses the button and sees nothing happen concludes the button
//      is broken instead of that this one is theirs to send by hand.
//   2. A request already WITH the gateway must not be advised to send it. Doing
//      that pays the creator twice.
//   3. A send claimed with no gateway id (`providerStatus: "sending"`) is the
//      one state where nothing automatic can fix it, and it must never read as
//      "wait" — somebody has to look at the gateway.
//
// Pure and clock-injected: no database, no waiting for real time to pass.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  payoutAttention,
  summarizePayoutAttention,
  type PayoutForAttention,
} from "@/lib/payout-attention";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);

function request(over: Partial<PayoutForAttention> = {}): PayoutForAttention {
  return {
    status: "PENDING",
    amount: 100_000,
    createdAt: ago(5),
    paymentMethod: "MPESA",
    accountDetails: "0682642219",
    bankName: null,
    providerWithdrawalId: null,
    providerStatus: null,
    ...over,
  };
}

/** The gateway's floor — deliberately not the same number as any amount here. */
const FLOOR = 30_000;
const read = (row: PayoutForAttention) => payoutAttention(row, { now: NOW, gatewayMinimum: FLOOR });

describe("payoutAttention — PENDING", () => {
  it("tells the admin that approving sends it through the gateway", () => {
    const attention = read(request({ amount: 100_000 }));

    expect(attention.nextAction).toBe("APPROVE");
    expect(attention.action).toContain("TZS 100,000");
    expect(attention.action).toContain("M-Pesa · 0682642219");
    expect(attention.action).toContain("gateway");
    // A request made minutes ago is not a problem yet.
    expect(attention.stuck).toBe(false);
    expect(attention.ageMinutes).toBe(5);
    expect(attention.ageLabel).toBe("5m ago");
  });

  it("says a below-floor request has to be sent by hand, before the button is pressed", () => {
    // The Mio saasha case: a waived creator withdrawing TZS 1,000. Approving
    // records the decision and sends nothing, and the admin has to know that
    // BEFORE they approve rather than after nothing happens.
    const attention = read(request({ amount: 1_000 }));

    expect(attention.nextAction).toBe("APPROVE");
    expect(attention.action).toContain("TZS 1,000");
    expect(attention.action).toMatch(/your phone/);
    expect(attention.action).toContain("30,000");
    expect(attention.action).toMatch(/mark it paid/i);
  });

  it("calls a request nobody has reviewed in a day stuck", () => {
    expect(read(request({ createdAt: ago(23 * 60) })).stuck).toBe(false);
    expect(read(request({ createdAt: ago(24 * 60) })).stuck).toBe(true);
  });
});

describe("payoutAttention — approved, sent, or stranded", () => {
  it("says to wait while the gateway has it, and never to send it again", () => {
    const attention = read(
      request({ status: "APPROVED", providerWithdrawalId: "84213", providerStatus: "processing" })
    );

    expect(attention.nextAction).toBe("WAIT_FOR_GATEWAY");
    expect(attention.stuck).toBe(false);
    // The reference the admin needs when they do have to ask the gateway.
    expect(attention.action).toContain("84213");
    expect(attention.action).toContain("processing");
    expect(attention.action).toMatch(/wait/i);
  });

  it("sends the admin to the gateway once waiting has stopped being plausible", () => {
    const attention = read(
      request({
        status: "APPROVED",
        providerWithdrawalId: "84213",
        providerStatus: "processing",
        createdAt: ago(3 * 60),
      })
    );

    expect(attention.nextAction).toBe("CHECK_GATEWAY");
    expect(attention.stuck).toBe(true);
    expect(attention.action).toContain("84213");
    // Re-sending is the expensive mistake, so it is named as one.
    expect(attention.action).toMatch(/re-sending/i);
  });

  it("tells the admin to pay an approved-but-unsent withdrawal themselves", () => {
    const attention = read(request({ status: "APPROVED", amount: 1_000, createdAt: ago(30) }));

    expect(attention.nextAction).toBe("SEND_BY_HAND");
    expect(attention.stuck).toBe(false);
    expect(attention.action).toContain("TZS 1,000");
    expect(attention.action).toContain("M-Pesa · 0682642219");
    expect(attention.action).toMatch(/mark it paid/i);
  });

  it("calls an approved payout unsent for six hours stuck", () => {
    expect(read(request({ status: "APPROVED", createdAt: ago(5 * 60) })).stuck).toBe(false);
    expect(read(request({ status: "APPROVED", createdAt: ago(6 * 60) })).stuck).toBe(true);
  });

  it("flags a send that started and left no gateway id, however fresh", () => {
    // `providerStatus: "sending"` is a claim on the row, not a verdict: the money
    // may be with the gateway and our record of the id never landed. Waiting is
    // not available — somebody has to read the gateway.
    const attention = read(request({ status: "APPROVED", providerStatus: "sending", createdAt: ago(1) }));

    expect(attention.nextAction).toBe("CHECK_GATEWAY");
    expect(attention.stuck).toBe(true);
    expect(attention.action).toMatch(/pay twice/i);
  });

  it("still says what to do when the age cannot be read", () => {
    // A bad timestamp must not turn into a confident sentence about how long
    // somebody has waited. The instruction survives; the claim about time does not.
    const attention = read(request({ status: "APPROVED", createdAt: "not a date" }));

    expect(attention.ageLabel).toBe("");
    expect(attention.ageMinutes).toBe(0);
    expect(attention.nextAction).toBe("SEND_BY_HAND");
    expect(attention.stuck).toBe(false);
  });
});

describe("summarizePayoutAttention", () => {
  it("counts the queue it was given, not the database", () => {
    const rows = [
      { amount: 100_000, attention: read(request({ amount: 100_000, createdAt: ago(5) })) },
      {
        amount: 1_000,
        attention: read(request({ amount: 1_000, status: "APPROVED", createdAt: ago(9 * 60) })),
      },
      {
        amount: 50_000,
        attention: read(request({ amount: 50_000, createdAt: ago(2 * 60) })),
      },
    ];

    expect(summarizePayoutAttention(rows)).toEqual({
      open: 3,
      stuck: 1,
      waitingAmount: 151_000,
      // The one that has waited longest, in the wording the notifications use.
      oldestAgeLabel: "9h ago",
    });
  });

  it("has nothing to say about an empty queue", () => {
    expect(summarizePayoutAttention([])).toEqual({
      open: 0,
      stuck: 0,
      waitingAmount: 0,
      oldestAgeLabel: null,
    });
  });
});
