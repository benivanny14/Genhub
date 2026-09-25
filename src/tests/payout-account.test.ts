// =============================================================================
// GENHUB - Where a creator's withdrawal should be sent
//
// The rule under test is the one that decides whether the withdrawal form opens
// pre-filled or empty: "the last account we actually paid to". Getting it wrong
// is not a crash, it is a form that asks a creator to retype their M-Pesa number
// — or, worse, one that pre-fills an account the payer cannot use.
//
// Pure functions, no database and no mocks.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  describePayoutAccount,
  isBankPayout,
  isValidPayoutMethod,
  lastPayoutAccount,
  PAYOUT_METHOD_LABEL,
} from "@/lib/payout-account";

const MPESA = { paymentMethod: "MPESA", accountDetails: "0682642219", bankName: null };
const BANK = {
  paymentMethod: "BANK_TRANSFER",
  accountDetails: "0123456789000",
  bankName: "CRDB",
};

describe("lastPayoutAccount", () => {
  it("is null when the creator has never been paid", () => {
    expect(lastPayoutAccount([])).toBeNull();
    expect(lastPayoutAccount(null)).toBeNull();
    expect(lastPayoutAccount(undefined)).toBeNull();
  });

  it("takes the newest usable row, since the API returns newest first", () => {
    expect(lastPayoutAccount([MPESA, BANK])).toBe(MPESA);
    expect(lastPayoutAccount([BANK, MPESA])).toBe(BANK);
  });

  it("skips a row whose account details are blank or unusable", () => {
    const blank = { paymentMethod: "MPESA", accountDetails: "   ", bankName: null };
    const short = { paymentMethod: "MPESA", accountDetails: "07", bankName: null };

    expect(lastPayoutAccount([blank, short, MPESA])).toBe(MPESA);
    expect(lastPayoutAccount([blank, short])).toBeNull();
  });

  // A method the payout schema would reject cannot be pre-filled into a form
  // that submits it: the creator would get a validation error they cannot act on.
  it("skips a method that is not payable", () => {
    expect(
      lastPayoutAccount([
        { paymentMethod: "BITCOIN", accountDetails: "bc1qxyz", bankName: null },
        MPESA,
      ])
    ).toBe(MPESA);
    expect(lastPayoutAccount([{ paymentMethod: "BITCOIN", accountDetails: "bc1qxyz" }])).toBeNull();
  });

  it("skips a bank row with no bank name, because the payer would not know which bank", () => {
    const nameless = { paymentMethod: "BANK_TRANSFER", accountDetails: "0123456789000", bankName: null };

    expect(lastPayoutAccount([nameless, MPESA])).toBe(MPESA);
  });

  it("keeps a bank row that names the bank", () => {
    expect(lastPayoutAccount([BANK])).toBe(BANK);
  });
});

describe("describePayoutAccount", () => {
  it("names the method and the number for a mobile-money payout", () => {
    expect(describePayoutAccount(MPESA)).toBe("M-Pesa · 0682642219");
  });

  it("names the bank too for a bank transfer", () => {
    expect(describePayoutAccount(BANK)).toBe("Bank transfer · CRDB · 0123456789000");
  });
});

describe("payout methods", () => {
  it("knows every method the API accepts, and only those", () => {
    expect(isValidPayoutMethod("MPESA")).toBe(true);
    expect(isValidPayoutMethod("BANK_TRANSFER")).toBe(true);
    expect(isValidPayoutMethod("paypal")).toBe(false);
  });

  it("labels every method, so no screen prints a raw enum", () => {
    for (const method of ["MPESA", "TIGO_PESA", "AIRTEL_MONEY", "BANK_TRANSFER"]) {
      expect(PAYOUT_METHOD_LABEL[method]).toBeTruthy();
    }
  });

  it("treats only a bank transfer as a bank payout", () => {
    expect(isBankPayout("BANK_TRANSFER")).toBe(true);
    expect(isBankPayout("MPESA")).toBe(false);
  });
});
