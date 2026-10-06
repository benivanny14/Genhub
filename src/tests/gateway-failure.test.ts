// =============================================================================
// GENHUB - Who a gateway refusal is about
//
// The bug this pins: a full day of failed checkouts, every one of them answered
// with "Daily API limit reached. Complete your KYC to remove this limit." to a
// customer buying a video. Nothing was charged, the customer's phone was fine,
// and the only thing broken was our own merchant account — reported to the wrong
// person, in the wrong voice, with no way to act on it.
//
// So the property under test is the SPLIT, not the wording:
//   * a fault that is about the customer's own payment is passed through — that
//     sentence ("Insufficient funds in your Halopesa account") is the product;
//   * a fault that is about OUR account is answered with our own plain sentence,
//     and the gateway's words go to the log with a reference;
//   * and the two must never swap. "Complete your KYC" is the case that must not
//     reach a customer, and "Insufficient funds" is the case that must not be
//     swallowed as ours.
// =============================================================================

import { describe, it, expect } from "vitest";
import { classifyGatewayFailure } from "@/lib/gateway-failure";

describe("classifyGatewayFailure", () => {
  describe("faults that are about OUR account", () => {
    it("classifies the daily API cap — the failure this module exists for", () => {
      const failure = classifyGatewayFailure(
        "Daily API limit reached. Complete your KYC to remove this limit. (100 calls per day)."
      );

      expect(failure.kind).toBe("account-limit");
      expect(failure.code).toBe("TEMPORARILY_UNAVAILABLE");
      // A 5xx, not the 502 the old code used: this is our side, and the client's
      // error taxonomy reads it as "nothing was charged".
      expect(failure.status).toBe(503);

      // The property that matters: the customer is NOT told about our KYC.
      expect(failure.message).not.toMatch(/kyc/i);
      expect(failure.message).not.toMatch(/api limit/i);
      expect(failure.message).toMatch(/nothing has been charged/i);
      // ...and the operator still gets the real sentence.
      expect(failure.gatewayMessage).toMatch(/daily api limit/i);
    });

    it("classifies an unfinished merchant account", () => {
      for (const raw of [
        "Please complete your KYC to continue",
        "Your account is not activated",
        "Merchant account not verified",
      ]) {
        const failure = classifyGatewayFailure(raw);
        expect(failure.kind).toBe("account-setup");
        expect(failure.message).not.toMatch(/kyc|activated|verified/i);
      }
    });

    it("classifies our own timeout and breaker text as unreachable, not as the gateway's words", () => {
      const timedOut = classifyGatewayFailure(
        "SonicPesa /payments/initiate-ussd-push-request timed out after 20s — the gateway did not answer"
      );
      expect(timedOut.kind).toBe("unreachable");
      expect(timedOut.message).toMatch(/nothing has been charged/i);
      // The internal sentence must not leak.
      expect(timedOut.message).not.toMatch(/timed out|20s|SonicPesa/);

      const open = classifyGatewayFailure(
        "SonicPesa has not answered its last calls, so this one was not sent."
      );
      expect(open.kind).toBe("unreachable");
    });
  });

  describe("faults that are about the CUSTOMER", () => {
    it("passes the gateway's own words through — they are the most useful sentence we have", () => {
      const failure = classifyGatewayFailure(
        "Insufficient funds in your Halopesa account. Please top up and try again."
      );

      expect(failure.kind).toBe("customer");
      expect(failure.code).toBe("GATEWAY_REJECTED");
      expect(failure.message).toBe(
        "Insufficient funds in your Halopesa account. Please top up and try again."
      );
    });

    it("does NOT swallow a customer's funds problem as our account fault", () => {
      // The tempting shortcut — matching the word "funds" — would hide the one
      // thing the customer can actually act on.
      expect(classifyGatewayFailure("Insufficient funds").kind).toBe("customer");
    });

    it("passes through a rejected phone number", () => {
      const failure = classifyGatewayFailure("Invalid phone number");
      expect(failure.kind).toBe("customer");
      expect(failure.message).toBe("Invalid phone number");
    });

    it("has a fallback sentence when the gateway said nothing at all", () => {
      const failure = classifyGatewayFailure("");
      expect(failure.kind).toBe("customer");
      expect(failure.message).toMatch(/refused/i);
      expect(failure.message.length).toBeGreaterThan(0);
    });
  });
});
