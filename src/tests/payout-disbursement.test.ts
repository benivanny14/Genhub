// =============================================================================
// GENHUB - Sending a creator their money
//
// This is the money-LEAVING half of the platform, and it had no integration at
// all before this: a withdrawal debited the balance, an admin was supposed to
// send the money from their own phone, and a request could be marked paid with a
// hand-typed string as its only proof. The production record of that is a payout
// marked PAID whose "receipt" was the creator's own name, and money that never
// arrived.
//
// Three things are pinned here because each one is a way to lose money:
//
//   1. WHICH METHOD GOES WHERE. Our enum is mapped to the gateway's names
//      explicitly. A bank whose name cannot be matched is refused rather than
//      guessed at — sending to the wrong bank is worse than not sending.
//   2. THE AMOUNT THE CREATOR GETS. The gateway takes a fee and pays
//      `net_amount`, which is less than the amount requested. Both numbers are
//      stored from its reply, never inferred.
//   3. NEVER TWICE. A payout is only complete when the gateway says so, and a
//      repeated `payout.success` must not re-notify or re-credit — the failure
//      mode of a duplicate delivery is paying the creator twice.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  balanceUpdate: vi.fn(),
  transaction: vi.fn(),
  notify: vi.fn(),
  audit: vi.fn(),
  config: {
    sonicPesa: {
      accessKey: "test-key",
      apiSecret: "test-secret",
      baseUrl: "https://sonicpesa.test/api/v1",
      secretKey: "test-webhook-secret",
      webhookToken: "test-webhook-token",
      payoutsEnabled: true,
      // The gateway's own floor, as configured. Replaced wholesale below, so it
      // has to be here or every compare against it is against `undefined`.
      minPayoutAmount: 30_000,
      sandbox: false,
    },
    nodeEnv: "test",
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    payoutRequest: {
      findFirst: (...a: unknown[]) => mocks.findFirst(...a),
      findUnique: (...a: unknown[]) => mocks.findFirst(...a),
      update: (...a: unknown[]) => mocks.update(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      count: async () => 0,
      findMany: async () => [],
    },
    creatorBalance: { update: (...a: unknown[]) => mocks.balanceUpdate(...a) },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.transaction();
      return fn({
        payoutRequest: { updateMany: (...a: unknown[]) => mocks.updateMany(...a) },
        creatorBalance: { update: (...a: unknown[]) => mocks.balanceUpdate(...a) },
      });
    },
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, ...mocks.config } };
});

vi.mock("@/lib/services/notify.service", () => ({
  createNotification: (...a: unknown[]) => mocks.notify(...a),
}));

vi.mock("@/lib/services/audit.service", () => ({
  AUDIT_ACTIONS: {
    payoutApprove: "payout.approve",
    payoutPaid: "payout.paid",
    payoutReject: "payout.reject",
  },
  recordAudit: (...a: unknown[]) => mocks.audit(...a),
}));

import {
  gatewayPayoutMethod,
  disbursePayout,
  settlePayoutFromGateway,
  gatewayPayoutReference,
  isBelowGatewayMinimum,
  gatewayFloorFromMessage,
  gatewayMinPayout,
} from "@/lib/services/payout-disbursement.service";
import {
  sonicpesaPayout,
  sonicpesaPayoutStatus,
  sonicpesaPayoutEventToStatus,
  sonicpesaPayoutStatusToInternal,
} from "@/lib/payments/sonicpesa";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the gateway's payout vocabulary", () => {
  it("recognises the payout event family and nothing else", () => {
    expect(sonicpesaPayoutEventToStatus("payout.pending")).toBe("pending");
    expect(sonicpesaPayoutEventToStatus("payout.success")).toBe("completed");
    expect(sonicpesaPayoutEventToStatus("PAYOUT.FAILED")).toBe("failed");
    // A payment event is not a payout event. Collapsing the two would answer a
    // payout callback with "order_id missing".
    expect(sonicpesaPayoutEventToStatus("payment.success")).toBeNull();
    expect(sonicpesaPayoutEventToStatus("payout.mystery")).toBeNull();
  });

  it("keeps an in-flight payout in flight", () => {
    expect(sonicpesaPayoutStatusToInternal("completed")).toBe("PAID");
    expect(sonicpesaPayoutStatusToInternal("failed")).toBe("FAILED");
    expect(sonicpesaPayoutStatusToInternal("reversed")).toBe("FAILED");
    expect(sonicpesaPayoutStatusToInternal("pending")).toBeNull();
  });
});

describe("which method goes where", () => {
  it("maps each wallet to the gateway's own name", () => {
    expect(gatewayPayoutMethod("MPESA")).toBe("M-Pesa");
    expect(gatewayPayoutMethod("TIGO_PESA")).toBe("Tigo Pesa");
    expect(gatewayPayoutMethod("AIRTEL_MONEY")).toBe("Airtel Money");
  });

  it("names the bank the creator typed, when it can", () => {
    expect(gatewayPayoutMethod("BANK_TRANSFER", "CRDB")).toBe("CRDB Bank");
    expect(gatewayPayoutMethod("BANK_TRANSFER", "nmb bank")).toBe("NMB Bank");
  });

  it("refuses a bank it cannot name rather than guessing", () => {
    // A free-text bank name is not a destination. Guessing here sends money to
    // the wrong place, which cannot be recalled.
    expect(gatewayPayoutMethod("BANK_TRANSFER", "Equity")).toBeNull();
    expect(gatewayPayoutMethod("BANK_TRANSFER", "")).toBeNull();
    expect(gatewayPayoutMethod("BANK_TRANSFER", null)).toBeNull();
  });

  it("refuses a method the gateway does not pay out to", () => {
    expect(gatewayPayoutMethod("CRYPTO")).toBeNull();
  });
});

describe("the gateway call itself", () => {
  it("sends the payout with BOTH headers and reads back the fee and the net", async () => {
    // The collect key alone is refused on the payout endpoint, so the second
    // header is not optional — without it every withdrawal fails at the gateway.
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return Promise.resolve(
          json({
            status: "success",
            message: "Payout request created successfully!",
            data: {
              withdrawal_id: 14,
              amount: 10000,
              fee: 600,
              net_amount: 9400,
              method: "Airtel Money",
              status: "pending",
            },
          })
        );
      })
    );

    const result = await sonicpesaPayout({
      amount: 10000,
      method: "Airtel Money",
      accountNumber: "255682812345",
      accountName: "Mio saasha",
    });

    expect(seenUrl).toContain("/payouts/create");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("test-key");
    expect(headers["X-API-SECRET"]).toBe("test-secret");

    const body = JSON.parse(String(seenInit?.body));
    expect(body).toEqual({
      amount: 10000,
      method: "Airtel Money",
      account_number: "255682812345",
      account_name: "Mio saasha",
    });

    expect(result.success).toBe(true);
    expect(result.payout?.withdrawalId).toBe(14);
    // The number that decides what the creator actually receives. It is 6% less
    // than was sent, and it has to survive the parse.
    expect(result.payout?.fee).toBe(600);
    expect(result.payout?.netAmount).toBe(9400);
  });

  it("asks for the status by the gateway's own withdrawal id", async () => {
    let seenUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        seenUrl = url;
        return Promise.resolve(
          json({
            status: "success",
            data: { withdrawal_id: 14, status: "completed", net_amount: 9400, fee: 600, amount: 10000 },
          })
        );
      })
    );

    const result = await sonicpesaPayoutStatus(14);

    expect(seenUrl).toContain("/payouts/status/14");
    expect(result.payout?.status).toBe("completed");
  });

  it("treats an application-level refusal in a 200 as a failure, not a payout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ status: "error", message: "Insufficient balance" })))
    );

    await expect(
      sonicpesaPayout({
        amount: 1000,
        method: "M-Pesa",
        accountNumber: "255682812345",
        accountName: "Test",
      })
    ).rejects.toThrow(/Insufficient balance/);
  });
});

describe("sending a withdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.balanceUpdate.mockResolvedValue({});
    mocks.notify.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
  });

  function request(overrides: Record<string, unknown> = {}) {
    mocks.findFirst.mockResolvedValue({
      id: "payout-1",
      creatorId: "creator-1",
      amount: 30_000,
      status: "PENDING",
      paymentMethod: "MPESA",
      accountDetails: "0712345678",
      bankName: null,
      providerWithdrawalId: null,
      providerNetAmount: null,
      creator: { displayName: "Ivanny", email: "ivanny@test" },
      ...overrides,
    });
  }

  it("does not send the same request twice", async () => {
    // The idempotency that stops a double payout. A second create would mint a
    // second withdrawal and the creator would be paid twice.
    request({ providerWithdrawalId: "14", status: "APPROVED" });

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("ALREADY_SENT");
  });

  it("sends a wallet payout and records what the gateway reported", async () => {
    request();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({
            status: "success",
            data: {
              withdrawal_id: 77,
              amount: 30000,
              fee: 1800,
              net_amount: 28200,
              method: "M-Pesa",
              status: "pending",
            },
          })
        )
      )
    );

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.withdrawalId).toBe(77);
      expect(outcome.fee).toBe(1800);
      // What actually reaches the handset.
      expect(outcome.netAmount).toBe(28200);
    }

    const data = mocks.update.mock.calls[0][0].data;
    expect(data.status).toBe("APPROVED");
    // Never PAID here: only the gateway's own verdict makes a payout paid.
    expect(data.providerWithdrawalId).toBe("77");
    expect(data.providerFee).toBe(1800);
    expect(data.providerNetAmount).toBe(28200);
  });

  it("normalises a wallet number and leaves a bank account alone", async () => {
    request({ paymentMethod: "TIGO_PESA", accountDetails: "0712 345 678" });
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return Promise.resolve(
          json({ status: "success", data: { withdrawal_id: 1, amount: 30000, fee: 1800, net_amount: 28200, status: "pending" } })
        );
      })
    );

    await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(body.account_number).toBe("255712345678");
  });

  it("does not send anything for a bank it cannot name", async () => {
    request({ paymentMethod: "BANK_TRANSFER", bankName: "Equity", accountDetails: "0123456789" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("UNSUPPORTED_METHOD");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  /*
   * The gateway's own floor, which is not the same thing as ours.
   *
   * An admin can waive Genhub's TZS 30,000 withdrawal minimum for one creator
   * (User.payoutMinimumWaived), and the creator can then request whatever they
   * hold — but the gateway refuses to SEND less than TZS 30,000. It answered a
   * real one with "The amount field must be at least 30000". Returning that as a
   * failure made a perfectly payable withdrawal look impossible; it is a reason
   * to pay by hand instead.
   */
  it("recognises a 'that amount is too small' complaint in the gateway's words", () => {
    expect(
      isBelowGatewayMinimum(
        "Internal server error: The amount field must be at least 30000."
      )
    ).toBe(true);
    expect(isBelowGatewayMinimum("minimum amount for this channel is 1000")).toBe(true);
    // A real refusal is not a floor complaint and must keep its own handling.
    expect(isBelowGatewayMinimum("Invalid account")).toBe(false);
  });

  it("reads the floor out of the gateway's own sentence", () => {
    // The reply is the current truth about the gateway's limit, so the number in
    // it is what the admin is told — not the one this deployment happens to carry.
    expect(
      gatewayFloorFromMessage(
        "Internal server error: The amount field must be at least 45000."
      )
    ).toBe(45_000);
    expect(gatewayFloorFromMessage("must be at least 30,000")).toBe(30_000);
    // A floor complaint with no number must not become one: the caller keeps what
    // it already had rather than recording a figure invented out of nothing.
    expect(gatewayFloorFromMessage("amount must be at least the minimum")).toBeNull();
    expect(gatewayFloorFromMessage("Invalid account")).toBeNull();
  });

  it("starts from the configured floor", () => {
    expect(gatewayMinPayout()).toBe(30_000);
  });

  it("refuses a below-floor payout without asking the gateway at all", async () => {
    request({ amount: 1_000 }); // the real case: a TZS 1,000 Airtel withdrawal
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("BELOW_GATEWAY_MINIMUM");
      // The sentence has to name the limit, or the admin cannot tell the
      // gateway's rule apart from the one an admin is allowed to waive.
      expect(outcome.message).toContain("30,000");
    }
    // Nothing was sent and nothing was written: the request is untouched, so the
    // admin can approve it and record the receipt from their own phone.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("answers the same way when the gateway itself is the one that says so", async () => {
    // The floor can move at the gateway; the reply still has to become an
    // instruction rather than an error.
    request();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json(
            { status: "error", message: "Internal server error: The amount field must be at least 30000." },
            400
          )
        )
      )
    );

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("BELOW_GATEWAY_MINIMUM");
    // The claim is handed back, so a corrected or re-approved request is not
    // left stuck as "sending".
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerStatus: null } })
    );
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("hands the claim back when the gateway refuses, so it can be retried", async () => {
    request();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ status: "error", message: "Invalid account" }, 400)))
    );

    const outcome = await disbursePayout({ payoutId: "payout-1", actorId: "admin-1" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("GATEWAY");
      expect(outcome.message).toContain("Invalid account");
    }
    // Released, not left claimed: an admin correcting the number must be able to
    // try again, and no money moved.
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerStatus: null } })
    );
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });
});

describe("what the gateway says afterwards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.balanceUpdate.mockResolvedValue({});
    mocks.notify.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
  });

  function openRequest(overrides: Record<string, unknown> = {}) {
    mocks.findFirst.mockResolvedValue({
      id: "payout-1",
      creatorId: "creator-1",
      amount: 30_000,
      status: "APPROVED",
      accountDetails: "0712345678",
      paymentMethod: "MPESA",
      providerNetAmount: 28200,
      ...overrides,
    });
  }

  it("marks it paid with the gateway's own id as the receipt", async () => {
    openRequest();
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 77,
      gatewayStatus: "completed",
      source: "webhook",
      netAmount: 28200,
    });

    expect(settlement.status).toBe("PAID");
    const data = mocks.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe("PAID");
    expect(data.paymentReference).toBe(gatewayPayoutReference(77));
    // The creator is told the net, because that is what their phone shows.
    expect(mocks.notify.mock.calls[0][0].message).toContain("28,200");
  });

  it("does not tell the creator twice about the same payout", async () => {
    // A duplicate `payout.success` is normal. Re-running the transition must be
    // a no-op, not a second notification.
    openRequest({ status: "PAID" });

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 77,
      gatewayStatus: "completed",
      source: "webhook",
    });

    expect(settlement.status).toBe("PAID");
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns the money when the network fails the payout", async () => {
    // The one outcome that must never be silent: the balance dropped when the
    // creator asked, and if the transfer fails the money has to come back.
    openRequest();
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 77,
      gatewayStatus: "failed",
      source: "reconcile",
    });

    expect(settlement.status).toBe("FAILED");
    expect(settlement.refunded).toBe(true);
    expect(mocks.balanceUpdate.mock.calls[0][0]).toMatchObject({
      where: { creatorId: "creator-1" },
      data: { availableBalance: { increment: 30_000 } },
    });
  });

  it("does not refund a payout twice", async () => {
    openRequest({ status: "REJECTED" });

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 77,
      gatewayStatus: "failed",
      source: "reconcile",
    });

    expect(settlement.refunded).toBeUndefined();
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("does nothing for a withdrawal id that is not ours", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 999,
      gatewayStatus: "completed",
      source: "webhook",
    });

    expect(settlement.handled).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("only records the gateway's word while a payout is still in flight", async () => {
    openRequest();

    const settlement = await settlePayoutFromGateway({
      withdrawalId: 77,
      gatewayStatus: "pending",
      source: "reconcile",
    });

    expect(settlement.status).toBe("PENDING");
    expect(mocks.update.mock.calls[0][0].data.providerStatus).toBe("pending");
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });
});
