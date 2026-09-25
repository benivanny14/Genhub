// =============================================================================
// GENHUB - HarakaPay LIVE mode (PAYMENT_SANDBOX=false)
//
// This suite locks in the fix for the "no USSD push ever reaches the phone"
// bug: while the sandbox flag was on, the app never called HarakaPay at all.
// Here the gateway module is replaced with a spy, so we can assert exactly
// what the server sends and how it reacts — without charging anyone.
//
//   1. a live top-up calls harakaCollect with our webhook URL and stores the
//      gateway order id (so the webhook / status poll can map it back)
//   2. a gateway rejection surfaces the gateway's own reason and fails the row
//   3. money reaches the customer's account even when no webhook arrives,
//      because /payments/status reconciles with HarakaPay
//   4. stale orders are swept: completed ones settle, and anything the gateway
//      still calls "processing" past the TTL becomes UNDER_INVESTIGATION —
//      never FAILED, because the customer may already have paid
//   5. a late approval is still honoured, even after under-investigation
//   6. an admin can resolve an investigation either way (grant / mark unpaid)
//   7. /api/dev/sandbox/complete is locked out once live charges are on
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

// Force live mode: key present + sandbox off (the production configuration)
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, any> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      nodeEnv: "test",
      appUrl: "https://genhub.test",
      harakaPay: {
        ...actual.default.harakPay,
        ...actual.default.harakaPay,
        apiKey: "test-key",
        sandbox: false,
      },
    },
  };
});

// Spy on the gateway itself — harakaErrorReason stays real
vi.mock("@/lib/payments/harakapay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/harakapay")>();
  return {
    ...actual,
    harakaCollect: vi.fn(),
    harakaStatus: vi.fn(),
  };
});

import prisma from "@/lib/db";
import {
  harakaCollect,
  harakaStatus,
  HarakaFloatEmptyError,
  FLOAT_EMPTY_CUSTOMER_MESSAGE,
} from "@/lib/payments/harakapay";
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

const collect = vi.mocked(harakaCollect);
const status = vi.mocked(harakaStatus);

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

function gatewayPayment(orderId: string, gatewayStatus: string, amount = 0) {
  return {
    success: true,
    payment: {
      order_id: orderId,
      status: gatewayStatus,
      amount,
      net_amount: amount,
      fee_amount: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
    },
  };
}

describeLive("HarakaPay live mode (sandbox off)", () => {
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
    // Default: every order the gateway is asked about is still unfinished, so
    // the sweeper never invents a settlement we didn't script.
    status.mockImplementation(async (orderId: string) =>
      gatewayPayment(orderId, "processing")
    );
  });

  it("calls HarakaPay collect with a signed webhook URL and stores its order id", async () => {
    collect.mockResolvedValueOnce({
      success: true,
      order_id: "hp_live_abc123",
      message: "USSD push sent to phone",
    });

    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 3_000,
        gateway: "HARAKAPAY",
        phoneNumber: PHONE,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // Sandbox marker must be gone — this was a real gateway round-trip
    expect(body.data.sandbox).toBeUndefined();
    expect(body.data.orderId).toBe("hp_live_abc123");

    expect(collect).toHaveBeenCalledTimes(1);
    const sent = collect.mock.calls[0][0];
    expect(sent.phone).toBe(PHONE);
    expect(sent.amount).toBe(3_000);
    expect(sent.webhookUrl).toContain("/api/webhooks/harakapay?t=");

    // The gateway order id is persisted so the webhook can find this row
    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, providerRef: "hp_live_abc123" },
      select: { status: true, type: true, amount: true },
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("PENDING");
    expect(tx!.type).toBe("WALLET_TOPUP");
    expect(tx!.amount).toBe(3_000);
  });

  it("refuses the whole order when the float is empty, and says the customer was not charged", async () => {
    // What `harakaCollect` throws before it sends anything: the merchant float
    // cannot pay for a USSD prompt, so a charge accepted now would never reach a
    // handset. The route must turn that into a refusal the customer can read —
    // not a 200 with "USSD push sent to phone" and an order nobody can settle.
    collect.mockRejectedValueOnce(new HarakaFloatEmptyError(0));

    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 2_000,
        gateway: "HARAKAPAY",
        phoneNumber: PHONE,
      })
    );
    const body = await res.json();

    // 503, and a code the client can branch on — not the 502 a broken gateway
    // gives, because this gateway is fine and we are the ones unable to sell.
    expect(res.status).toBe(503);
    expect(body.code).toBe("GATEWAY_FLOAT_EMPTY");
    expect(body.error).toBe(FLOAT_EMPTY_CUSTOMER_MESSAGE);

    // The row is closed rather than left PENDING: a checkout that can never
    // settle would block the next attempt and blame the customer for it.
    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, amount: 2_000, type: "WALLET_TOPUP", status: "FAILED" },
      orderBy: { createdAt: "desc" },
      select: { status: true, metadata: true },
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("FAILED");
    expect((tx!.metadata as { refusal?: string })?.refusal).toBe("FLOAT_EMPTY");
  });

  it("surfaces the gateway's own rejection reason and fails the transaction", async () => {
    collect.mockResolvedValueOnce({
      success: false,
      error: "Invalid mobile number.",
    });

    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 2_000,
        gateway: "HARAKAPAY",
        phoneNumber: PHONE,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("GATEWAY_REJECTED");
    expect(body.error).toContain("Invalid mobile number.");

    const failed = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, status: "FAILED", amount: 2_000 },
      select: { id: true },
    });
    expect(failed).not.toBeNull();
  });

  it("credits the wallet with no webhook at all (status poll reconciles)", async () => {
    collect.mockResolvedValueOnce({
      success: true,
      order_id: "hp_live_recon1",
      message: "USSD push sent to phone",
    });

    const res = await topupPost(
      post("/api/payments/topup", {
        amount: 4_000,
        gateway: "HARAKAPAY",
        phoneNumber: PHONE,
      })
    );
    const { data } = await res.json();

    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    // No webhook arrives — the client polls and we ask the gateway directly
    status.mockResolvedValueOnce(gatewayPayment(data.orderId, "completed", 4_000));

    const polled = await statusGet(get(`/api/payments/status/${data.orderId}`), {
      params: { orderId: data.orderId },
    });
    const polledBody = await polled.json();

    expect(polled.status).toBe(200);
    expect(polledBody.data.status).toBe("SUCCESS");
    expect(status).toHaveBeenCalledWith("hp_live_recon1");

    const after = await db.user.findUnique({ where: { id: ctx.viewerId } });
    expect(after!.walletBalance - before!.walletBalance).toBe(4_000);
  });

  // ---------------------------------------------------------------------------
  // Stale-pending sweeper: the failure mode where the gateway accepts an order
  // but the USSD prompt is never answered (or never delivered at all).
  // ---------------------------------------------------------------------------

  it("settles a pending order the gateway has already completed", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 2_500,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "hp_sweep_settle",
        // older than the freshness window, younger than the hard TTL
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    });

    // Only this order is complete — anything else stays unfinished, so the
    // sweeper can never settle an unrelated real transaction by accident.
    status.mockImplementation(async (orderId: string) =>
      orderId === "hp_sweep_settle"
        ? gatewayPayment(orderId, "completed", 2_500)
        : gatewayPayment(orderId, "processing")
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
        gateway: "HARAKAPAY",
        providerRef: "hp_sweep_investigate",
        createdAt: new Date(Date.now() - 3 * 60 * 60_000), // 3h > 1h TTL
      },
    });

    // Gateway still reports it unfinished. This is indistinguishable from
    // "the customer approved it and the settlement is stuck", so we must not
    // call it a failure.
    status.mockImplementation(async (orderId: string) =>
      gatewayPayment(orderId, "processing", 1_500)
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
  // delivery path that would have resolved it — so if only a human could re-check
  // an investigation, a payment that settled minutes later would sit unresolved
  // until somebody happened to look.
  it("leaves a recent processing order alone but keeps asking about flagged ones", async () => {
    const tx = await db.transaction.create({
      data: {
        userId: ctx.viewerId,
        amount: 1_200,
        type: "WALLET_TOPUP",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "hp_sweep_fresh",
        createdAt: new Date(Date.now() - 12 * 60_000),
      },
    });

    // Gateway has no verdict on anything.
    status.mockImplementation(async (orderId: string) =>
      gatewayPayment(orderId, "processing")
    );

    const result = await reconcileStalePayments({
      olderThanMinutes: 10,
      userId: ctx.viewerId,
    });

    // The fresh one is inside the TTL, the flagged one from the previous test is
    // re-asked and still unresolved — the customer is not told twice.
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

    // The sweeper asks the gateway about the PROVIDER reference; the internal id
    // is what we hand back to processPaymentWebhook.
    status.mockImplementation(async (orderId: string) =>
      orderId === flagged!.providerRef
        ? gatewayPayment(orderId, "completed", flagged!.amount)
        : gatewayPayment(orderId, "processing")
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
        gateway: "HARAKAPAY",
        providerRef: "hp_late_settle",
        metadata: { expired: true, reason: "gateway_never_settled" },
      },
    });

    const before = await db.user.findUnique({ where: { id: ctx.viewerId } });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "hp_late_settle",
      amount: 1_800,
      status: "SUCCESS",
      provider: "HARAKAPAY",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_real_fail",
        metadata: { gatewayError: "insufficient balance" },
      },
    });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "hp_real_fail",
      amount: 900,
      status: "SUCCESS",
      provider: "HARAKAPAY",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_inv_late",
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });

    const outcome = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: "hp_inv_late",
      amount: 3_000,
      status: "SUCCESS",
      provider: "HARAKAPAY",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_inv_grant",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_inv_unpaid",
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
      transactionId: "hp_inv_unpaid",
      amount: 1_100,
      status: "SUCCESS",
      provider: "HARAKAPAY",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_already_paid",
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
        gateway: "HARAKAPAY",
        providerRef: "hp_inv_recheck",
        metadata: { investigation: true },
      },
    });

    status.mockImplementation(async (orderId: string) =>
      gatewayPayment(orderId, "processing", 1_400)
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
        gateway: "HARAKAPAY",
        providerRef: "hp_inv_recheck_ok",
        metadata: { investigation: true },
      },
    });

    status.mockImplementation(async (orderId: string) =>
      gatewayPayment(orderId, "completed", 1_600)
    );

    const result = await recheckPaymentCharge(tx.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settled).toBe(true);

    const after = await db.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
  });

  it("refuses sandbox completion once live charges are enabled", async () => {
    const res = await completePost(
      post("/api/dev/sandbox/complete", { orderId: "hp_live_abc123" })
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("real gateway charges");
    // Nothing was ever sent to the gateway by this request
    expect(collect).not.toHaveBeenCalled();
  });
});
