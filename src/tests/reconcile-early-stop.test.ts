// =============================================================================
// GENHUB - The reconcile sweep must not grind through a dead gateway
//
// `reconcileStalePayments` asks the gateway about every pending charge, one at a
// time. Once the gateway has stopped answering, the breaker in
// lib/payments/harakapay refuses further calls instantly — so the sweep would
// race through the remaining rows doing nothing but inflating `errors`, and
// report a `checked` count that looks like work.
//
// This pins the two behaviours that stop that: the sweep stops iterating when
// the breaker opens, and it stops before walking the queue at all when the
// breaker is already open. `unchecked`/`gatewayUnavailable` are what make the
// short sweep visible in the heartbeat instead of hiding behind a small number.
//
// Deliberately database-free: prisma and the gateway are mocked, so this runs
// everywhere `npm test` runs, including CI without a throwaway database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn(), update: vi.fn() }));

const gw = vi.hoisted(() => ({
  /** What the breaker reports; the test flips it. */
  open: false,
  status: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { transaction: { findMany: db.findMany, update: db.update } },
}));

// Force live mode (key present, sandbox off) — src/tests/setup-env.ts pins
// PAYMENT_SANDBOX=true, and the sweep returns immediately in sandbox.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      harakaPay: {
        apiKey: "test-key",
        baseUrl: "https://harakapay.test",
        webhookToken: "test-webhook-token",
        sandbox: false,
      },
    },
  };
});

vi.mock("@/lib/payments/harakapay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/harakapay")>();
  return {
    ...actual,
    harakaStatus: gw.status,
    // Stands in for the breaker: the sweep only reads `open`.
    harakaGatewayState: () => ({
      open: gw.open,
      openUntil: 0,
      failures: 0,
      attempted: 0,
      skipped: 0,
    }),
  };
});

import { reconcileStalePayments } from "@/lib/services/payment-reconcile.service";

/** Pending rows old enough to sweep, but inside the 1-hour hard TTL. */
function pendingRows(count: number) {
  const createdAt = new Date(Date.now() - 20 * 60_000);
  return Array.from({ length: count }, (_, i) => ({
    id: `tx${i}`,
    userId: "viewer-1",
    amount: 1000,
    status: "PENDING",
    providerRef: `HP${i}`,
    createdAt,
  }));
}

beforeEach(() => {
  db.findMany.mockReset();
  db.update.mockReset();
  gw.status.mockReset();
  gw.open = false;
});

describe("reconcile sweep and the gateway breaker", () => {
  it("stops as soon as the breaker opens, and reports what it never asked about", async () => {
    db.findMany.mockResolvedValue(pendingRows(5));
    let calls = 0;
    gw.status.mockImplementation(async () => {
      calls += 1;
      // Two failures in a row is what opens the real breaker.
      if (calls >= 2) gw.open = true;
      throw new Error("HarakaPay /api/v1/status/HP timed out after 20s");
    });

    const result = await reconcileStalePayments();

    // Two rows tried, three never touched: the sweep gave up when the gateway did.
    expect(gw.status).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(2);
    expect(result.errors).toBe(2);
    expect(result.gatewayUnavailable).toBe(true);
    expect(result.unchecked).toBe(3);
  });

  it("does not walk the queue at all when the breaker is already open", async () => {
    gw.open = true;
    db.findMany.mockResolvedValue(pendingRows(5));

    const result = await reconcileStalePayments();

    expect(gw.status).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
    expect(result.unchecked).toBe(5);
    expect(result.gatewayUnavailable).toBe(true);
  });

  it("leaves the cut-short flags clear when the gateway answers", async () => {
    db.findMany.mockResolvedValue(pendingRows(3));
    gw.status.mockResolvedValue({
      success: true,
      payment: { order_id: "HP0", status: "processing", amount: 1000, net_amount: 970, fee_amount: 30, created_at: new Date().toISOString() },
    });

    const result = await reconcileStalePayments();

    expect(gw.status).toHaveBeenCalledTimes(3);
    expect(result.checked).toBe(3);
    expect(result.stillProcessing).toBe(3);
    expect(result.gatewayUnavailable).toBe(false);
    expect(result.unchecked).toBe(0);
  });
});
