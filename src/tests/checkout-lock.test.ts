// =============================================================================
// GENHUB - When a checkout lock lifts
//
// A USSD prompt that nobody approves must not lock a customer out forever. The
// rule is one function (services/checkout-lock.service.ts) used by the video
// purchase AND the subscription checkout, so these are the cases that matter:
//
//   * a fresh prompt keeps the lock (no second charge while one is live)
//   * a stale one is ASKED about first — releasing without asking would be the
//     one way to lose a payment that already went through
//   * only when the gateway has no verdict is the lock released, and the row is
//     released as FAILED + metadata.expired so a late settlement still counts
//   * a gateway that will not answer is not evidence the money never moved; the
//     lock is still released, but nothing is told a lie about it
//
// Everything external is mocked: no database, no gateway, no mail.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  sonicpesaStatus: vi.fn(),
  processPaymentWebhook: vi.fn(),
  notifyPaymentResult: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: { updateMany: (...args: unknown[]) => mocks.updateMany(...args) },
  },
}));

vi.mock("@/lib/config", () => ({
  default: { sonicPesa: { accessKey: "test-key", sandbox: false } },
}));

vi.mock("@/lib/payments/sonicpesa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/sonicpesa")>();
  return {
    ...actual,
    sonicpesaStatus: (...args: unknown[]) => mocks.sonicpesaStatus(...args),
  };
});

vi.mock("@/lib/services/webhook.service", () => ({
  processPaymentWebhook: (...args: unknown[]) => mocks.processPaymentWebhook(...args),
}));

vi.mock("@/lib/services/payment-notify.service", () => ({
  notifyPaymentResult: (...args: unknown[]) => mocks.notifyPaymentResult(...args),
}));

import config from "@/lib/config";
import { CHECKOUT_TTL_MS, resolvePendingCheckout } from "@/lib/services/checkout-lock.service";

function pending(overrides: Partial<Parameters<typeof resolvePendingCheckout>[0]> = {}) {
  return {
    id: "tx-1",
    amount: 2_000,
    providerRef: "HP123",
    createdAt: new Date(Date.now() - (CHECKOUT_TTL_MS + 5_000)),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (config.sonicPesa as { accessKey: string; sandbox: boolean }).accessKey = "test-key";
  (config.sonicPesa as { accessKey: string; sandbox: boolean }).sandbox = false;
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.processPaymentWebhook.mockResolvedValue({ processed: true });
  mocks.notifyPaymentResult.mockResolvedValue(undefined);
});

describe("resolvePendingCheckout", () => {
  it("keeps the lock while the prompt is still fresh — and never asks the gateway", async () => {
    const outcome = await resolvePendingCheckout(
      pending({ createdAt: new Date(Date.now() - 60_000) })
    );

    expect(outcome.state).toBe("fresh");
    if (outcome.state === "fresh") {
      expect(outcome.minutesLeft).toBeGreaterThan(0);
      expect(outcome.minutesLeft).toBeLessThanOrEqual(10);
    }
    expect(mocks.sonicpesaStatus).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("settles through the webhook path when the gateway says SUCCESS, and grants instead of releasing", async () => {
    mocks.sonicpesaStatus.mockResolvedValue({
      success: true,
      payment: { status: "SUCCESS" },
    });

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("paid");
    expect(mocks.processPaymentWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "tx-1", status: "SUCCESS" })
    );
    // A paid charge is never released.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentResult).not.toHaveBeenCalled();
  });

  it("releases the lock when the gateway still has no verdict", async () => {
    mocks.sonicpesaStatus.mockResolvedValue({
      success: true,
      payment: { status: "processing" },
    });

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("released");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tx-1", status: "PENDING" },
        data: { status: "FAILED", metadata: { expired: true } },
      })
    );
    expect(mocks.notifyPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-1", outcome: "FAILED", reason: "expired" })
    );
  });

  it("still releases when the gateway cannot be reached — an unanswered call is not a verdict", async () => {
    mocks.sonicpesaStatus.mockRejectedValue(new Error("ECONNREFUSED"));

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("released");
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    // The release is still recorded as expired, so a late settlement is honoured.
    expect(mocks.updateMany.mock.calls[0][0].data.metadata).toEqual({ expired: true });
  });

  it("releases a sandbox row without calling the gateway at all", async () => {
    (config.sonicPesa as { accessKey: string; sandbox: boolean }).sandbox = true;

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("released");
    expect(mocks.sonicpesaStatus).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not release or notify twice when a settlement landed first", async () => {
    mocks.sonicpesaStatus.mockResolvedValue({
      success: true,
      payment: { status: "processing" },
    });
    // The conditional update matched nothing: the row moved on between our read
    // and our write.
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("released");
    expect(mocks.notifyPaymentResult).not.toHaveBeenCalled();
  });

  it("lets the webhook processor own a gateway-reported failure", async () => {
    mocks.sonicpesaStatus.mockResolvedValue({
      success: true,
      payment: { status: "failed" },
    });

    const outcome = await resolvePendingCheckout(pending());

    expect(outcome.state).toBe("released");
    expect(mocks.processPaymentWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" })
    );
    // The row is already FAILED and the customer already told — no second release.
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
