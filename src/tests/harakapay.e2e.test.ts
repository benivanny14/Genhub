// =============================================================================
// GENHUB - HarakaPay end-to-end payment flow (real database)
//
// Exercises the entire purchase pipeline exactly as production runs it:
//   purchase (sandbox gateway) -> status PENDING -> HarakaPay webhook ->
//   processPaymentWebhook (70/30 split, access grant, earnings) ->
//   status SUCCESS -> idempotency checks -> 14-day release job
//
// Auth is mocked (the handlers need a request scope Next doesn't provide in
// vitest); everything else — Prisma, webhook token, balance math — is real.
// Runs only when DATABASE_URL is resolvable (.env.local is loaded by
// src/tests/setup-env.ts); otherwise the whole suite is skipped.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

// Mutable context shared with the auth mock (set in beforeAll)
const ctx = vi.hoisted(() => ({
  viewerId: "",
  creatorId: "",
  videoId: "",
  amount: 10_000,
}));

// Replace only the request-scope helpers; keep the real AuthError class so
// `instanceof AuthError` in the routes' catch blocks still works.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
    requireRole: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
  };
});

import prisma from "@/lib/db";
import config from "@/lib/config";
import { POST as purchasePost } from "@/app/api/payments/purchase/route";
import { POST as topupPost } from "@/app/api/payments/topup/route";
import { GET as statusGet } from "@/app/api/payments/status/[orderId]/route";
import { POST as webhookPost } from "@/app/api/webhooks/harakapay/route";
import { POST as completePost } from "@/app/api/dev/sandbox/complete/route";
import { POST as subscriptionsPost } from "@/app/api/subscriptions/route";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

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

describeE2E("HarakaPay E2E: purchase -> webhook -> status -> DB", () => {
  let orderId = "";
  let transactionId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `e2ecreator${stamp}`;
    ctx.viewerId = `e2eviewer${stamp}`;
    ctx.videoId = `e2evideo${stamp}`;

    await prisma.user.create({
      data: {
        id: ctx.creatorId,
        email: `${ctx.creatorId}@e2e.test`,
        passwordHash: "e2e-not-a-real-hash",
        displayName: "E2E Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: ctx.viewerId,
        email: `${ctx.viewerId}@e2e.test`,
        passwordHash: "e2e-not-a-real-hash",
        displayName: "E2E Viewer",
        role: "VIEWER",
      },
    });
    await prisma.video.create({
      data: {
        id: ctx.videoId,
        creatorId: ctx.creatorId,
        title: "E2E Test Video",
        bunnyVideoId: `e2e-${stamp}`,
        price: ctx.amount,
        isPublished: true,
        teaserDuration: 15,
      },
    });
  });

  afterAll(async () => {
    // Reverse-order cleanup so FKs stay satisfied
    await prisma.videoAccess.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.videoEarning.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.viewerId] } },
    });
    await prisma.transaction.deleteMany({
      where: { OR: [{ userId: ctx.viewerId }, { creatorId: ctx.creatorId }] },
    });
    await prisma.video.deleteMany({ where: { id: ctx.videoId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ctx.creatorId, ctx.viewerId] } },
    });
    await prisma.$disconnect();
  });

  it("creates a PENDING transaction with a HarakaPay-style order id", async () => {
    const res = await purchasePost(
      post("/api/payments/purchase", {
        videoId: ctx.videoId,
        gateway: "HARAKAPAY",
        phoneNumber: "0712345678",
        email: "e2e@viewer.test",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.sandbox).toBe(true);
    expect(body.data.amount).toBe(ctx.amount);
    expect(body.data.orderId).toMatch(/^hp_sbx_/);

    orderId = body.data.orderId;
    transactionId = body.data.transactionId;

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("PENDING");
    expect(tx!.providerRef).toBe(orderId);
    expect(tx!.gateway).toBe("HARAKAPAY");
  });

  it("status polling reports PENDING before the webhook lands", async () => {
    const res = await statusGet(get(`/api/payments/status/${orderId}`), {
      params: { orderId },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("PENDING");
  });

  it("rejects webhooks with the wrong shared token", async () => {
    const res = await webhookPost(
      new NextRequest(`http://localhost/api/webhooks/harakapay?t=WRONG`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_id: orderId, status: "completed" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("processes the real HarakaPay webhook (completed)", async () => {
    const token = config.harakaPay.webhookToken;
    // Supplied by src/tests/setup-env.ts when the machine has no .env.local, so
    // this is the real verification path rather than a fixture token.
    expect(token).toBeTruthy();

    const res = await webhookPost(
      new NextRequest(
        `http://localhost/api/webhooks/harakapay?t=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            order_id: orderId,
            status: "completed",
            amount: ctx.amount,
            net_amount: ctx.amount - 600,
            fee_amount: 600,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          }),
        }
      )
    );

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("applies the 70/30 split and grants access in the database", async () => {
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    const expectedFee = Math.round(ctx.amount * (config.business.platformFeePercent / 100));
    const expectedCreatorCut = ctx.amount - expectedFee;

    expect(tx!.status).toBe("SUCCESS");
    expect(tx!.platformFee).toBe(expectedFee);
    expect(tx!.creatorCut).toBe(expectedCreatorCut);

    // Access granted
    const access = await prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId: ctx.viewerId, videoId: ctx.videoId } },
    });
    expect(access).not.toBeNull();

    // Creator balance: 70% in the 14-day holding, nothing released yet
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });
    expect(balance).not.toBeNull();
    expect(balance!.pendingBalance).toBe(expectedCreatorCut);
    expect(balance!.availableBalance).toBe(0);
    expect(balance!.releasedTotal).toBe(0);
    expect(balance!.totalEarned).toBe(expectedCreatorCut);

    // Per-video earnings + purchase counter
    const earning = await prisma.videoEarning.findUnique({
      where: { videoId: ctx.videoId },
    });
    expect(earning!.totalEarned).toBe(expectedCreatorCut);
    expect(earning!.totalPurchases).toBe(1);

    const video = await prisma.video.findUnique({ where: { id: ctx.videoId } });
    expect(video!.purchaseCount).toBe(1);
  });

  it("status polling reports SUCCESS after the webhook", async () => {
    const res = await statusGet(get(`/api/payments/status/${orderId}`), {
      params: { orderId },
    });
    const body = await res.json();
    expect(body.data.status).toBe("SUCCESS");
  });

  it("is idempotent: webhook replay does not double-credit", async () => {
    const token = config.harakaPay.webhookToken;
    const res = await webhookPost(
      new NextRequest(
        `http://localhost/api/webhooks/harakapay?t=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            order_id: orderId,
            status: "completed",
            amount: ctx.amount,
            net_amount: ctx.amount - 600,
            fee_amount: 600,
            created_at: new Date().toISOString(),
          }),
        }
      )
    );
    expect(res.status).toBe(200);

    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });
    const expectedCreatorCut =
      ctx.amount - Math.round(ctx.amount * (config.business.platformFeePercent / 100));
    expect(balance!.pendingBalance).toBe(expectedCreatorCut); // unchanged
    expect(balance!.totalEarned).toBe(expectedCreatorCut);
  });

  it("refuses to complete an already-completed order twice", async () => {
    const res = await completePost(
      post("/api/dev/sandbox/complete", { orderId })
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_PROCESSED");
  });

  it("blocks buying the same video again (already has access)", async () => {
    const res = await purchasePost(
      post("/api/payments/purchase", {
        videoId: ctx.videoId,
        gateway: "HARAKAPAY",
        phoneNumber: "0712345678",
        email: "e2e@viewer.test",
      })
    );
    expect(res.status).toBe(409);
  });

  it("runs the top-up flow through sandbox completion (wallet credited)", async () => {
    const topUpAmount = 5_000;
    const res = await topupPost(
      post("/api/payments/topup", {
        amount: topUpAmount,
        gateway: "HARAKAPAY",
        phoneNumber: "0712345678",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.sandbox).toBe(true);
    expect(body.data.orderId).toMatch(/^hp_sbx_/);

    const done = await completePost(
      post("/api/dev/sandbox/complete", { orderId: body.data.orderId })
    );
    expect((await done.json()).success).toBe(true);

    const user = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(user!.walletBalance).toBe(topUpAmount);
  });

  it("releases earnings only after the 14-day holding period (idempotent)", async () => {
    const expectedCreatorCut =
      ctx.amount - Math.round(ctx.amount * (config.business.platformFeePercent / 100));

    // Fresh earnings are NOT mature yet
    const early = await releaseMatureEarnings(ctx.creatorId);
    expect(early.released).toBe(0);

    // Age the successful purchase past the holding window
    const cutoff = new Date(
      Date.now() - (config.business.holdingPeriodDays + 1) * 86_400_000
    );
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { createdAt: cutoff },
    });

    const result = await releaseMatureEarnings(ctx.creatorId);
    expect(result.released).toBe(expectedCreatorCut);
    expect(result.creators).toBe(1);

    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });
    expect(balance!.pendingBalance).toBe(0);
    expect(balance!.availableBalance).toBe(expectedCreatorCut);
    expect(balance!.releasedTotal).toBe(expectedCreatorCut);

    // Running again must be a no-op
    const again = await releaseMatureEarnings(ctx.creatorId);
    expect(again.released).toBe(0);
    const after = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });    expect(after!.availableBalance).toBe(expectedCreatorCut);
  });
});

// =============================================================================
// Subscription paid by phone — the same gateway pipeline as PPV purchases:
// PENDING SUBSCRIPTION txn -> HarakaPay webhook -> plan activated + 70/30 split
// =============================================================================

describeE2E("HarakaPay E2E: subscription by phone", () => {
  const stamp = Date.now();
  const creatorA = `e2esubcre${stamp}`;
  const viewerA = `e2esubvw${stamp}`;
  let orderId = "";
  let transactionId = "";
  let firstExpiresAt: Date | null = null;

  beforeAll(async () => {
    // The auth mock reads ctx.viewerId on every request
    ctx.viewerId = viewerA;

    await prisma.user.create({
      data: {
        id: creatorA,
        email: `${creatorA}@e2e.test`,
        passwordHash: "e2e-not-a-real-hash",
        displayName: "E2E Sub Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: viewerA,
        email: `${viewerA}@e2e.test`,
        passwordHash: "e2e-not-a-real-hash",
        displayName: "E2E Sub Viewer",
        role: "VIEWER",
      },
    });
  });

  afterAll(async () => {
    await prisma.creatorSubscription.deleteMany({ where: { creatorId: creatorA } });
    await prisma.creatorProfile.deleteMany({ where: { userId: creatorA } });
    await prisma.notification.deleteMany({ where: { userId: creatorA } });
    await prisma.transaction.deleteMany({
      where: { OR: [{ userId: viewerA }, { creatorId: creatorA }] },
    });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: creatorA } });
    await prisma.user.deleteMany({ where: { id: { in: [creatorA, viewerA] } } });
  });

  it("creates a PENDING subscription checkout for the phone number", async () => {
    const res = await subscriptionsPost(
      post("/api/subscriptions", {
        creatorId: creatorA,
        phoneNumber: "0712345678",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.sandbox).toBe(true);
    expect(body.data.amount).toBe(5000); // default monthly price
    expect(body.data.orderId).toMatch(/^hp_sbx_/);

    orderId = body.data.orderId;
    transactionId = body.data.transactionId;

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe("PENDING");
    expect(tx!.type).toBe("SUBSCRIPTION");
    expect(tx!.creatorId).toBe(creatorA);
    expect(tx!.amount).toBe(5000);

    // Not subscribed yet — no money has moved
    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: viewerA, creatorId: creatorA } },
    });
    expect(sub).toBeNull();
  });

  it("blocks a second checkout while one is still pending", async () => {
    const res = await subscriptionsPost(
      post("/api/subscriptions", {
        creatorId: creatorA,
        phoneNumber: "0712345678",
      })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PENDING_PAYMENT");
  });

  it("webhook activates the plan, splits 70/30 and resynces the counter", async () => {
    const token = config.harakaPay.webhookToken;
    const res = await webhookPost(
      new NextRequest(
        `http://localhost/api/webhooks/harakapay?t=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            order_id: orderId,
            status: "completed",
            amount: 5000,
            net_amount: 4700,
            fee_amount: 300,
            created_at: new Date().toISOString(),
          }),
        }
      )
    );
    expect(res.status).toBe(200);

    // Plan active for ~1 month
    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: viewerA, creatorId: creatorA } },
    });
    expect(sub).not.toBeNull();
    expect(sub!.isActive).toBe(true);
    expect(sub!.price).toBe(5000);
    const in20Days = Date.now() + 20 * 86_400_000;
    const in40Days = Date.now() + 40 * 86_400_000;
    expect(sub!.expiresAt.getTime()).toBeGreaterThan(in20Days);
    expect(sub!.expiresAt.getTime()).toBeLessThan(in40Days);
    firstExpiresAt = sub!.expiresAt;

    // Transaction fulfilled with the 70/30 split recorded
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    expect(tx!.status).toBe("SUCCESS");
    const platformFee = Math.round(5000 * (config.business.platformFeePercent / 100));
    expect(tx!.platformFee).toBe(platformFee);
    expect(tx!.creatorCut).toBe(5000 - platformFee);
    expect(tx!.providerRef).toBeTruthy();

    // Creator credited into the 14-day holding (nothing available yet)
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: creatorA },
    });
    expect(balance!.pendingBalance).toBe(5000 - platformFee);
    expect(balance!.availableBalance).toBe(0);
    expect(balance!.totalEarned).toBe(5000 - platformFee);

    // Public subscriber counter resynced from real rows
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId: creatorA },
    });
    expect(profile!.totalSubscribers).toBe(1);

    // Creator notified
    const note = await prisma.notification.findFirst({
      where: { userId: creatorA, title: { contains: "follower" } },
    });
    expect(note).not.toBeNull();
  });

  it("webhook replay is idempotent (no double credit, no counter drift)", async () => {
    const token = config.harakaPay.webhookToken;
    const res = await webhookPost(
      new NextRequest(
        `http://localhost/api/webhooks/harakapay?t=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            order_id: orderId,
            status: "completed",
            amount: 5000,
            net_amount: 4700,
            fee_amount: 300,
            created_at: new Date().toISOString(),
          }),
        }
      )
    );
    expect(res.status).toBe(200);

    const platformFee = Math.round(5000 * (config.business.platformFeePercent / 100));
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: creatorA },
    });
    expect(balance!.pendingBalance).toBe(5000 - platformFee); // unchanged

    const profile = await prisma.creatorProfile.findUnique({
      where: { userId: creatorA },
    });
    expect(profile!.totalSubscribers).toBe(1); // still 1

    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId: viewerA, creatorId: creatorA } },
    });
    expect(sub!.expiresAt).toEqual(firstExpiresAt); // not extended again
  });

  it("rejects a new subscribe attempt while the plan is active", async () => {
    const res = await subscriptionsPost(
      post("/api/subscriptions", {
        creatorId: creatorA,
        phoneNumber: "0712345678",
      })
    );
    expect(res.status).not.toBe(200);
    expect((await res.json()).success).toBe(false);
  });
});
