// =============================================================================
// GENHUB - SonicPesa LIVE mode (PAYMENT_SANDBOX=false)
//
// This suite locks in the fix for the "no USSD push ever reaches the phone"
// bug: while the sandbox flag was on, the app never called the gateway at all.
// Here the gateway module is replaced with a spy, so we can assert exactly what
// the server sends and how it reacts — without charging anyone.
//
//   1. a live top-up calls sonicpesaCollect with our order reference and stores
//      it as providerRef (so the webhook / status poll can map it back)
//   2. a gateway rejection surfaces the gateway's own reason and fails the row
//   3. money reaches the customer's account even when no webhook arrives,
//      because /payments/status reconciles with SonicPesa
//   4. stale orders are swept: settled ones settle, and anything the gateway
//      still calls "PROCESSING" past the TTL becomes UNDER_INVESTIGATION —
//      never FAILED, because the customer may already have paid
//   5. a late approval is still honoured, even after under-investigation
//   6. an admin can resolve an investigation either way (grant / mark unpaid)
//   7. /api/dev/sandbox/complete is locked out once live charges are on
//
// Runs only against a throwaway database (see src/tests/setup-env.ts).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const ctx = vi.hoisted(() => ({ viewerId: "" }));

// Auth is mocked (handlers need a request scope vitest doesn't provide)
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
    requireRole: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
  };
});

// Force live mode: credentials present + sandbox off (production configuration)
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, any> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      nodeEnv: "test",
      appUrl: "https://genhub.test",
      sonicPesa: {
        accessKey: "test-key",
        secretKey: "test-secret",
        baseUrl: "https://sonicpesa.test/api/v1",
        webhookToken: "test-webhook-token",
        fallbackEmail: "payments@test.local",
        sandbox: false,
      },
    },
  };
});

// Spy on the gateway itself — sonicpesaErrorReason stays real
vi.mock("@/lib/payments/sonicpesa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/sonicpesa")>();
  return {
    ...actual,
    sonicpesaCollect: vi.fn(),
    sonicpesaStatus: vi.fn(),
  };
});

import prisma from "@/lib/db";
import { sonicpesaCollect, sonicpesaStatus } from "@/lib/payments/sonicpesa";
import { POST as topupPost } from "@/app/api/payments/topup/route";
import { GET as statusGet } from "@/app/api/payments/status/[orderId]/route";
import { POST as completePost } from "@/app/api/dev/sandbox/complete/route";
import {
  reconcileStalePayments,
  resolveInvestigation,
  recheckPaymentCharge,
} from "@/lib/services/payment-reconcile.service";
import { processPaymentWebhook } from "@/lib/services/webhook.service";

// Untyped handles so the tests can set createdAt / metadata that the route
// helpers wouldn't let us express.
const db = prisma as unknown as {
  transaction: {
    create: (a: unknown) => Promise<{ id: string }>;
    findUnique: (a: unknown) => Promise<{ status: string; metadata: unknown } | null>;
  };
  user: { findUnique: (a: unknown) => Promise<{ walletBalance: number } | null> };
};

const collect = vi.mocked(sonicpesaCollect);
const status = vi.mocked(sonicpesaStatus);

const describeLive = process.env.DATABASE_URL ? describe : describe.skip;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

/** SonicPesa's own order id for a collect request (it assigns one). */
function gatewayOrderId(request: { orderReference: string }): string {
  return `sp_${request.orderReference}`;
}

/** What `sonicpesaStatus` returns: a normalized single-payment envelope. */
function gatewayPayment(orderReference: string, gatewayStatus: string, amount = 0) {
  return {
    success: true,
    payment: {
      status: gatewayStatus,
      orderId: orderReference,
      amount,
    },
  };
}

describeLive("SonicPesa live mode (sandbox off)", () => {
  const PHONE = "0712345678";

  beforeAll(async () => {
    ctx.viewerId = `livetest${Date.now()}`;
    await prisma.user.create({
      data: {
        id: ctx.viewerId,
        email: `${ctx.viewerId}@live.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Live Test Viewer",
        role: "VIEWER",
      },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: ctx.viewerId } });
    await prisma.user.deleteMany({ where: { id: ctx.viewerId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    collect.mockReset();
    status.mockReset();
    // SonicPesa ASSIGNS its own order id; that value is what the route stores as
    // providerRef, so the webhook and the status poll match on it.
    collect.mockImplementation(async (request) => ({
      success: true,
      orderReference: gatewayOrderId(request),
      message: "USSD push sent — approve it on your phone",
    }));
    // Default: every order is still unfinished, so the sweeper never invents a
    // settlement we didn't script.
    status.mockImplementation(async (orderReference: string) =>
      gatewayPayment(orderReference, "PROCESSING")
    );
  });

  it("calls SonicPesa collect and stores the gateway's order id", async () => {
    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 3_000,
        gateway: "SONICPESA",
        phoneNumber: PHONE,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // Sandbox marker must be gone — this was a real gateway round-trip
    expect(body.data.sandbox).toBeUndefined();

    expect(collect).toHaveBeenCalledTimes(1);
    const sent = collect.mock.calls[0][0];
    // Normalized to the MSISDN form the gateway requires.
    expect(sent.phone).toBe("255712345678");
    expect(sent.amount).toBe(3_000);
    // Our own trace reference is alphanumeric and bounded.
    expect(sent.orderReference).toMatch(/^[A-Z0-9]{1,20}$/);
    // The client is handed the GATEWAY's order id, which is what it polls with.
    const orderId = gatewayOrderId(sent);
    expect(body.data.orderId).toBe(orderId);

    // The gateway order id is persisted as providerRef so the webhook can find
    // this row.
    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, providerRef: orderId },
      select: { status: true, type: true, amount: true },
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("PENDING");
    expect(tx!.type).toBe("WALLET_TOPUP");
    expect(tx!.amount).toBe(3_000);
  });

  it("surfaces the gateway's own rejection reason and fails the transaction", async () => {
    collect.mockResolvedValueOnce({
      success: false,
      error: "Invalid / unsupported phone number",
    });

    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 2_000,
        gateway: "SONICPESA",
        phoneNumber: PHONE,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("GATEWAY_REJECTED");
    expect(body.error).toContain("Invalid / unsupported phone number");

    const failed = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, status: "FAILED", amount: 2_000 },
      select: { id: true },
    });
    expect(failed).not.toBeNull();
  });

  it("credits the wallet with no webhook at all (status poll reconciles)", async () => {
    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 4_000,
        gateway: "SONICPESA",
        phoneNumber: PHONE,
      })
    );
    const { data } = await res.json();

    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    // No webhook arrives — the client polls and we ask the gateway directly
    status.mockResolvedValueOnce(gatewayPayment(data.orderId, "SUCCESS", 4_000));

    const polled = await statusGet(get(`/api/payments/status/${data.orderId}`), {
      // Next 15 route handlers receive params as a promise.
      params: Promise.resolve({ orderId: data.orderId }),
    });
    const polledBody = await polled.json();

    expect(polled.status).toBe(200);
    expect(polledBody.data.status).toBe("SUCCESS");
    expect(status).toHaveBeenCalledWith(data.orderId);

    const after = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(after!.walletBalance - before!.walletBalance).toBe(4_000);
  });

  // ---------------------------------------------------------------------------
  // Stale-pending sweeper: the failure mode where the gateway accepts an order
  // but the USSD prompt is never answered (or never delivered at all).
  // ---------------------------------------------------------------------------

  it("settles a pending order the gateway has already settled", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 2_500,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "SONICPESA",
        providerRef: "sp_sweep_settle",
        // older than the freshness window, younger than the hard TTL
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    });

    status.mockImplementation(async (orderReference: string) =>
      orderReference === "sp_sweep_settle"
        ? gatewayPayment(orderReference, "SUCCESS", 2_500)
        : gatewayPayment(orderReference, "PROCESSING")
    );

    const result = await reconcileStalePayments({
      olderThanMinutes: 10,
      userId: ctx.viewerId,
    });
    expect(result.checked).toBe(1);
    expect(result.settledSuccess).toBe(1);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
  });

  it("flags a never-settled charge past the hard TTL as UNDER_INVESTIGATION", async () => {
    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_500,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "SONICPESA",
        providerRef: "sp_sweep_investigate",
        createdAt: new Date(Date.now() - 3 * 60 * 60_000), // 3h > 1h TTL
      },
    });

    status.mockImplementation(async (orderReference: string) =>
      gatewayPayment(orderReference, "PROCESSING", 1_500)
    );

    const result = await reconcileStalePayments({
      olderThanMinutes: 10,
      userId: ctx.viewerId,
    });
    expect(result.checked).toBe(1);
    expect(result.underInvestigation).toBe(1);
    expect(result.settledFailed).toBe(0);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("UNDER_INVESTIGATION");
    const meta = after!.metadata as { investigation?: boolean; expired?: boolean };
    expect(meta.investigation).toBe(true);
    // Crucially NOT soft-expired: that flag is what licenses a retry
    expect(meta.expired).toBeUndefined();

    // Flagging an investigation must never move money either
    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance).toBe(before!.walletBalance);
  });

  // The sweeper must keep asking about charges it already flagged. The usual
  // reason a charge got stuck is that the webhook never arrived — the very
  // delivery path that would have resolved it.
  it("leaves a recent processing order alone but keeps asking about flagged ones", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_200,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "SONICPESA",
        providerRef: "sp_sweep_fresh",
        createdAt: new Date(Date.now() - 12 * 60_000),
      },
    });

    status.mockImplementation(async (orderReference: string) =>
      gatewayPayment(orderReference, "PROCESSING")
    );

    const result = await reconcileStalePayments({
      olderThanMinutes: 10,
      userId: ctx.viewerId,
    });

    expect(result.stillProcessing).toBe(1);
    expect(result.underInvestigation).toBe(0);
    expect(result.awaitingResolution).toBeGreaterThanOrEqual(1);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("PENDING");

    // And the already-notified customer was not notified again.
    const flagged = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, status: "UNDER_INVESTIGATION" },
      select: { id: true },
    });
    expect(flagged).not.toBeNull();
    const notices = await prisma.notification.count({
      where: { userId: ctx.viewerId, title: { contains: "checking" } },
    });
    expect(notices).toBe(1);
  });

  // And when the gateway finally has a verdict, the mere existence of the
  // investigation must not stop the money from landing.
  it("settles a flagged charge the moment the gateway gets a verdict", async () => {
    const flagged = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, status: "UNDER_INVESTIGATION" },
      select: { id: true, amount: true, userId: true, providerRef: true },
    });
    expect(flagged).not.toBeNull();

    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    status.mockImplementation(async (orderReference: string) =>
      orderReference === flagged!.providerRef
        ? gatewayPayment(orderReference, "SUCCESS", flagged!.amount)
        : gatewayPayment(orderReference, "PROCESSING")
    );

    const result = await reconcileStalePayments({
      olderThanMinutes: 0,
      userId: ctx.viewerId,
    });
    expect(result.settledSuccess).toBe(1);

    const after = await db.transaction.findUnique({ where: { id: flagged!.id } });
    expect(after!.status).toBe("SUCCESS");

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance - before!.walletBalance).toBe(flagged!.amount);
  });

  // The safety property that makes soft-expiring acceptable: a customer who
  // approves the prompt late still gets what they paid for.
  it("honours a late settlement that arrives after the order was soft-expired", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_800,
        type: "WALLET_TOPUP",
        status: "FAILED", // soft-expired by the sweeper
        gateway: "SONICPESA",
        providerRef: "sp_late_settle",
        metadata: { expired: true, reason: "gateway_never_settled" },
      },
    });

    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "sp_late_settle",
      amount: 1_800,
      status: "SUCCESS",
      provider: "SONICPESA",
    });

    expect(outcome.processed).toBe(true);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance - before!.walletBalance).toBe(1_800);
  });

  it("still refuses a webhook for an order that genuinely failed", async () => {
    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 900,
        type: "WALLET_TOPUP",
        status: "FAILED",
        gateway: "SONICPESA",
        providerRef: "sp_real_fail",
        metadata: { gatewayError: "insufficient balance" },
      },
    });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "sp_real_fail",
      amount: 900,
      status: "SUCCESS",
      provider: "SONICPESA",
    });

    expect(outcome.processed).toBe(false);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("FAILED");

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance).toBe(before!.walletBalance);
  });

  // The whole point of UNDER_INVESTIGATION: a charge the customer really did
  // approve still lands, so nobody loses money to our "we can't tell" state.
  it("settles a late approval that arrives while under investigation", async () => {
    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 3_000,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "SONICPESA",
        providerRef: "sp_inv_late",
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "sp_inv_late",
      amount: 3_000,
      status: "SUCCESS",
      provider: "SONICPESA",
    });

    expect(outcome.processed).toBe(true);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance - before!.walletBalance).toBe(3_000);
  });

  it("GRANT resolves an investigation by settling it like a real payment", async () => {
    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 2_000,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "SONICPESA",
        providerRef: "sp_inv_grant",
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });

    const resolved = await resolveInvestigation({
      transactionId: tx.id,
      outcome: "GRANT",
      actorId: "admin-test",
      note: "operator confirmed the debit",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.amount).toBe(2_000);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance - before!.walletBalance).toBe(2_000);
  });

  it("MARK_UNPAID releases an investigation and keeps the door open for a late settlement", async () => {
    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_100,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "SONICPESA",
        providerRef: "sp_inv_unpaid",
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });

    const resolved = await resolveInvestigation({
      transactionId: tx.id,
      outcome: "MARK_UNPAID",
      actorId: "admin-test",
    });
    expect(resolved.ok).toBe(true);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("FAILED");
    const meta = after!.metadata as {
      expired?: boolean;
      investigation?: boolean;
      resolvedBy?: string;
    };
    expect(meta.expired).toBe(true);
    expect(meta.investigation).toBe(false);
    expect(meta.resolvedBy).toBe("admin-test");

    // Releasing must not move money...
    const mid = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(mid!.walletBalance).toBe(before!.walletBalance);

    // ...and an "it didn't go through" decision must still honour the money if
    // the network turns out to have taken it after all.
    const late = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "sp_inv_unpaid",
      amount: 1_100,
      status: "SUCCESS",
      provider: "SONICPESA",
    });
    expect(late.processed).toBe(true);

    const user = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(user!.walletBalance - before!.walletBalance).toBe(1_100);
  });

  it("refuses to resolve a charge that is not under investigation", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 700,
        type: "WALLET_TOPUP",
        status: "SUCCESS",
        gateway: "SONICPESA",
        providerRef: "sp_already_paid",
      },
    });

    const resolved = await resolveInvestigation({
      transactionId: tx.id,
      outcome: "MARK_UNPAID",
      actorId: "admin-test",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("not_under_investigation");

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
  });

  it("re-check leaves an investigation alone when the gateway has no verdict", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_400,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "SONICPESA",
        providerRef: "sp_inv_recheck",
        metadata: { investigation: true },
      },
    });

    status.mockImplementation(async (orderReference: string) =>
      gatewayPayment(orderReference, "PROCESSING", 1_400)
    );

    const result = await recheckPaymentCharge(tx.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settled).toBe(false);

    // Still unresolved — asking again must never silently downgrade it
    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("UNDER_INVESTIGATION");
  });

  it("re-check settles immediately once the gateway has a verdict", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_600,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "SONICPESA",
        providerRef: "sp_inv_recheck_ok",
        metadata: { investigation: true },
      },
    });

    status.mockImplementation(async (orderReference: string) =>
      gatewayPayment(orderReference, "SETTLED", 1_600)
    );

    const result = await recheckPaymentCharge(tx.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settled).toBe(true);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
  });

  it("refuses sandbox completion once live charges are enabled", async () => {
    const res = await completePost(
      post("/api/dev/sandbox/complete", { orderId: "sp_live_abc123" })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("real gateway charges");
    // Nothing was ever sent to the gateway by this request
    expect(collect).not.toHaveBeenCalled();
  });
});
