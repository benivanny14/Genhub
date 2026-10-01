// =============================================================================
// GENHUB - The referral bonus is released at settlement, and only there
//
// The bonus is a write of real money to a wallet that can be spent on videos,
// tips and subscriptions — and, through a creator's pending balance, withdrawn
// as cash. Where it is released therefore matters as much as how much it is:
//
//   * released from processPaymentWebhook, it is paid for money that actually
//     arrived (this is the single choke point every gateway payment passes
//     through);
//   * released anywhere earlier, it is paid for a USSD prompt nobody approved.
//
// service tests cover the arithmetic; this one covers the WIRING — that the
// settlement path calls the release at all, and that a failed charge does not.
// Every collaborator is mocked, so it runs without a database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateTransaction: vi.fn(),
  creditCreator: vi.fn(),
  creditWallet: vi.fn(),
  notifyPaymentResult: vi.fn(),
  releaseReferralBonus: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { transaction: { findFirst: mocks.findFirst, update: mocks.updateTransaction } },
}));

vi.mock("@/lib/services/balance.service", () => ({
  creditCreatorForPurchase: mocks.creditCreator,
  creditWallet: mocks.creditWallet,
  splitRevenue: (amount: number) => ({ platformFee: 0, creatorCut: amount }),
}));

vi.mock("@/lib/services/payment-notify.service", () => ({
  notifyPaymentResult: mocks.notifyPaymentResult,
}));

vi.mock("@/lib/services/subscription.service", () => ({ grantSubscription: vi.fn() }));

vi.mock("@/lib/services/referral.service", () => ({
  releaseReferralBonus: mocks.releaseReferralBonus,
}));

vi.mock("@/lib/coupons", () => ({ consumeCoupon: vi.fn() }));

vi.mock("@/lib/redis", () => ({ cacheDel: mocks.cacheDel }));

vi.mock("@/lib/payments/gateway", () => ({
  assertSupportedSettlementProvider: () => {},
}));

import { processPaymentWebhook } from "@/lib/services/webhook.service";

/** The row an order id resolves to. */
function order(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "order-1",
    userId: "viewer-1",
    creatorId: "creator-1",
    videoId: "video-1",
    amount: 2_000,
    type: "PPV_PURCHASE",
    status: "PENDING",
    gateway: "CLICKPESA",
    metadata: null,
    ...overrides,
  };
  mocks.findFirst.mockResolvedValue(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateTransaction.mockResolvedValue({});
  mocks.creditCreator.mockResolvedValue(undefined);
  mocks.notifyPaymentResult.mockResolvedValue(undefined);
  mocks.cacheDel.mockResolvedValue(undefined);
  mocks.releaseReferralBonus.mockResolvedValue({ paid: false, reason: "NOT_REFERRED" });
});

describe("processPaymentWebhook and the referral bonus", () => {
  it("asks for the bonus when a customer's payment settles", async () => {
    order();
    mocks.releaseReferralBonus.mockResolvedValue({ paid: true, referrerId: "referrer-1" });

    const result = await processPaymentWebhook({
      orderId: "order-1",
      transactionId: "provider-ref",
      amount: 2_000,
      status: "SUCCESS",
      provider: "CLICKPESA",
    });

    expect(result.processed).toBe(true);
    // Asked for by the VIEWER who paid — the referrer is found from their own
    // row's attribution, so a caller cannot name a referrer.
    expect(mocks.releaseReferralBonus).toHaveBeenCalledWith({ referredUserId: "viewer-1" });
  });

  it("asks for nothing when the charge failed", async () => {
    order();

    await processPaymentWebhook({
      orderId: "order-1",
      transactionId: "provider-ref",
      amount: 2_000,
      status: "FAILED",
      provider: "CLICKPESA",
    });

    expect(mocks.releaseReferralBonus).not.toHaveBeenCalled();
  });

  it("asks for nothing for an order that was already processed", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const result = await processPaymentWebhook({
      orderId: "unknown-order",
      transactionId: "provider-ref",
      amount: 2_000,
      status: "SUCCESS",
      provider: "CLICKPESA",
    });

    expect(result.processed).toBe(false);
    expect(mocks.releaseReferralBonus).not.toHaveBeenCalled();
  });
});
