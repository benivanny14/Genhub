// =============================================================================
// GENHUB - Payment under investigation
//
// The failure this suite protects against is a business one, not a technical
// one: a customer approves a USSD prompt, the gateway never settles the charge,
// and we tell them "payment failed — try again". They pay a second time and buy
// one video twice.
//
//   1. WE NEVER SAY "FAILED"  A charge we can neither confirm nor deny becomes
//      UNDER_INVESTIGATION, never FAILED, and its notice tells the customer in
//      plain words not to pay again.
//   2. THE PAYWALL STOPS SELLING  The video they tried to buy reports the
//      pending investigation, so the page cannot offer to sell it again.
//   3. THE ADMIN CAN END IT  "Customer paid" unlocks the purchase through the
//      same settlement path as a webhook; "Never paid" releases the charge while
//      still honouring the money if the network turns out to have taken it.
//
// Auth is mocked (the handlers need a request scope Next doesn't provide in
// vitest); Prisma and the balance math are real. Skips without DATABASE_URL.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

const ctx = vi.hoisted(() => ({ viewerId: "", adminId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
    requireRole: async () => ({ userId: ctx.adminId, role: "ADMIN" as const }),
    getCurrentUser: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
  };
});

import prisma from "@/lib/db";
import { GET as videoGet } from "@/app/api/videos/[id]/route";
import { POST as adminPaymentsPost } from "@/app/api/admin/payments/route";
import { recheckPaymentCharge } from "@/lib/services/payment-reconcile.service";
import { notifyPaymentResult } from "@/lib/services/payment-notify.service";
import { processPaymentWebhook } from "@/lib/services/webhook.service";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describeDb("Payment under investigation", () => {
  let creatorId = "";
  let viewerId = "";
  let videoId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    creatorId = `invcreator${stamp}`;
    viewerId = `invviewer${stamp}`;
    videoId = `invvideo${stamp}`;

    await prisma.user.create({
      data: {
        id: creatorId,
        email: `${creatorId}@inv.test`,
        passwordHash: "inv-not-a-real-hash",
        displayName: "Inv Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: viewerId,
        email: `${viewerId}@inv.test`,
        passwordHash: "inv-not-a-real-hash",
        displayName: "Inv Viewer",
        role: "VIEWER",
        phone: "0682000001",
      },
    });
    await prisma.video.create({
      data: {
        id: videoId,
        title: "Inv video",
        price: 2_000,
        teaserDuration: 30,
        bunnyVideoId: `invbunny${stamp}`,
        // Non-null on purpose: `previewUrl` is the full scene for demo and
        // side-loaded rows, so the leak assertions only mean something if the
        // column actually holds a URL here.
        previewUrl: "https://scene.test/full-scene.m3u8",
        teaserClipUrl: "https://scene.test/trailer.m3u8",
        creatorId,
        // Live, because every assertion below is about what a VIEWER sees on
        // the paywall. The detail route refuses an unpublished video to anyone
        // but its creator and an admin (a viewer cannot reach a scene nobody
        // published), so leaving this at the database default would test the
        // 404 instead of the paywall.
        isPublished: true,
      },
    });

    ctx.viewerId = viewerId;
    ctx.adminId = `invadmin${stamp}`;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: viewerId } });
    await prisma.transaction.deleteMany({ where: { userId: viewerId } });
    await prisma.videoAccess.deleteMany({ where: { viewerId } });
    await prisma.videoEarning.deleteMany({ where: { videoId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId } });
    await prisma.video.deleteMany({ where: { id: videoId } });
    await prisma.user.deleteMany({ where: { id: { in: [creatorId, viewerId] } } });
    await prisma.$disconnect();
  });

  /** Every test starts from a blank slate: these rows are all test-created. */
  async function reset() {
    await prisma.notification.deleteMany({ where: { userId: viewerId } });
    await prisma.transaction.deleteMany({ where: { userId: viewerId } });
    await prisma.videoAccess.deleteMany({ where: { viewerId, videoId } });
    await prisma.videoEarning.deleteMany({ where: { videoId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId } });
  }

  /** A charge stuck exactly where the real ones got stuck. */
  async function stuckCharge(amount = 2_000) {
    return prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount,
        type: "PPV_PURCHASE",
        status: "UNDER_INVESTIGATION",
        gateway: "HARAKAPAY",
        providerRef: `hp_inv_${Math.random().toString(36).slice(2, 10)}`,
        metadata: {
          investigation: true,
          reason: "gateway_never_settled",
          gatewayStatus: "processing",
        },
      },
    });
  }

  async function fetchVideo() {
    const res = await videoGet(
      new NextRequest(`http://localhost/api/videos/${videoId}`),
      { params: { id: videoId } }
    );
    return { status: res.status, body: await res.json() };
  }

  async function latestNotice() {
    return prisma.notification.findFirst({
      where: { userId: viewerId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. What the customer is told
  // ---------------------------------------------------------------------------

  it("warns the customer instead of reporting a failure", async () => {
    await reset();
    const tx = await stuckCharge();

    await notifyPaymentResult({
      transactionId: tx.id,
      outcome: "UNDER_INVESTIGATION",
    });

    const notice = await latestNotice();
    expect(notice).not.toBeNull();
    expect(notice!.title).toContain("checking");
    expect(notice!.type).toBe("warning");

    // The sentence that stops someone paying twice, and the absence of the one
    // that would send them straight back to checkout.
    const message = notice!.message.toLowerCase();
    expect(message).toContain("do not pay again");
    expect(message).not.toContain("did not go through");
    expect(message).not.toContain("try again");
  });

  it("does not move money or invent earnings for an unresolved charge", async () => {
    await reset();
    const tx = await stuckCharge(1_500);
    const before = await prisma.user.findUnique({ where: { id: viewerId } });

    await notifyPaymentResult({ transactionId: tx.id, outcome: "UNDER_INVESTIGATION" });
    await notifyPaymentResult({ transactionId: tx.id, outcome: "UNDER_INVESTIGATION" });

    const after = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(after!.walletBalance).toBe(before!.walletBalance);

    const fresh = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(fresh!.status).toBe("UNDER_INVESTIGATION");

    const earning = await prisma.videoEarning.findUnique({ where: { videoId } });
    expect(earning?.totalEarned ?? 0).toBe(0);
    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance?.pendingBalance ?? 0).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. The paywall refuses to sell it again
  // ---------------------------------------------------------------------------

  it("reports the pending charge on the video so the paywall cannot resell it", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    const { status, body } = await fetchVideo();

    expect(status).toBe(200);
    expect(body.data.hasAccess).toBe(false);
    expect(body.data.paymentUnderInvestigation).toBeTruthy();
    expect(body.data.paymentUnderInvestigation.transactionId).toBe(tx.id);
    expect(body.data.paymentUnderInvestigation.amount).toBe(2_000);
    expect(body.data.paymentUnderInvestigation.providerRef).toBe(tx.providerRef);
  });

  it("stops reporting it once the admin grants the purchase", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "grant",
        transactionId: tx.id,
        note: "operator confirmed the debit",
      })
    );
    expect(res.status).toBe(200);

    const { body } = await fetchVideo();

    // The customer now owns it: the flag is gone and access is on.
    expect(body.data.paymentUnderInvestigation).toBeNull();
    expect(body.data.hasAccess).toBe(true);
    expect(body.data.accessSource).toBe("purchase");
  });

  // ---------------------------------------------------------------------------
  // 3. The admin's two decisions
  // ---------------------------------------------------------------------------

  it("GRANT settles through the same path as a real payment (70/30 split)", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "grant",
        transactionId: tx.id,
        note: "network confirmed",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.amount).toBe(2_000);

    const settled = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(settled!.status).toBe("SUCCESS");

    // 70/30: the creator gets their share, and it lands in *pending* (subject to
    // the 14-day holding period), never straight into the withdrawable balance.
    const earning = await prisma.videoEarning.findUnique({ where: { videoId } });
    expect(earning!.totalEarned).toBe(1_400);
    expect(earning!.totalPurchases).toBe(1);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(1_400);
    expect(balance!.availableBalance).toBe(0);
  });

  it("MARK_UNPAID releases the charge and licenses a retry", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "mark_unpaid",
        transactionId: tx.id,
        note: "operator says no debit was posted",
      })
    );
    expect(res.status).toBe(200);

    const released = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(released!.status).toBe("FAILED");

    const meta = released!.metadata as {
      expired?: boolean;
      investigation?: boolean;
      resolvedBy?: string;
    };
    // `expired` is the flag that permits a new checkout, and crucially it is
    // also what keeps a late settlement valid — so this decision cannot lose
    // money that turns up afterwards.
    expect(meta.expired).toBe(true);
    expect(meta.investigation).toBe(false);
    expect(meta.resolvedBy).toBe(ctx.adminId);

    // Releasing must not pay the creator for money that never arrived.
    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance?.pendingBalance ?? 0).toBe(0);

    const notice = await latestNotice();
    expect(notice!.message.toLowerCase()).toContain("safe");
  });

  it("still honours the money if it lands after we said it would not", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    await adminPaymentsPost(
      post("/api/admin/payments", { action: "mark_unpaid", transactionId: tx.id })
    );
    const before = await prisma.user.findUnique({ where: { id: viewerId } });

    const late = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: tx.providerRef!,
      amount: 2_000,
      status: "SUCCESS",
      provider: "HARAKAPAY",
      metadata: { reconciled: "late" },
    });

    expect(late.processed).toBe(true);

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");

    // The purchase is delivered rather than the wallet silently credited.
    const access = await prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId, videoId } },
    });
    expect(access).not.toBeNull();

    const me = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(me!.walletBalance).toBe(before!.walletBalance);
  });

  it("clears the investigation flag when the gateway settles it on its own", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    // No admin involved: the settlement turns up by itself.
    const settled = await processPaymentWebhook({
      orderId: tx.id,
      transactionId: tx.providerRef!,
      amount: 2_000,
      status: "SUCCESS",
      provider: "HARAKAPAY",
    });
    expect(settled.processed).toBe(true);

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const meta = after!.metadata as {
      investigation?: boolean;
      settledLate?: boolean;
      reason?: string;
    };

    // A settled charge must not keep claiming to be under investigation, or the
    // admin queue and the audit trail lie about it.
    expect(meta.investigation).toBe(false);
    expect(meta.settledLate).toBe(true);
    // The original reason is kept as history.
    expect(meta.reason).toBe("gateway_never_settled");
  });

  it("settles a purchase the customer already owns without losing the creator's cut", async () => {
    // Regression: the viewer already owns the video (they paid from their wallet
    // after the charge got stuck) and the stuck charge settles late. The money is
    // real, so the creator must still be paid — but `videoAccess.create` threw on
    // the unique key, rolling back the whole settlement and leaving money we
    // received permanently unrecorded.
    await reset();
    await prisma.videoAccess.create({ data: { viewerId, videoId } });

    const tx = await stuckCharge(2_000);

    const res = await adminPaymentsPost(
      post("/api/admin/payments", { action: "grant", transactionId: tx.id })
    );
    expect(res.status).toBe(200);

    const settled = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(settled!.status).toBe("SUCCESS");

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(1_400);

    // Still exactly one access row.
    const accesses = await prisma.videoAccess.count({ where: { viewerId, videoId } });
    expect(accesses).toBe(1);
  });

  it("refuses to act on a charge that is already settled", async () => {
    await reset();
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount: 500,
        type: "PPV_PURCHASE",
        status: "SUCCESS",
        gateway: "HARAKAPAY",
        providerRef: `hp_done_${Math.random().toString(36).slice(2, 10)}`,
      },
    });

    // `expire` and the investigation resolutions guard on different states, so
    // each reports its own conflict code — but all three refuse.
    const expectations: Array<[string, string]> = [
      ["grant", "NOT_UNDER_INVESTIGATION"],
      ["mark_unpaid", "NOT_UNDER_INVESTIGATION"],
      ["expire", "NOT_PENDING"],
    ];

    for (const [action, code] of expectations) {
      const res = await adminPaymentsPost(
        post("/api/admin/payments", { action, transactionId: tx.id })
      );
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.code).toBe(code);
    }

    const still = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(still!.status).toBe("SUCCESS");
  });

  it("answers with a usable result when the gateway cannot be reached", async () => {
    await reset();
    const tx = await stuckCharge(2_000);

    // No gateway is configured in the test env, so harakaStatus is never called.
    // The point is that the action still answers instead of throwing a 500, and
    // leaves the charge exactly where it was: an unreachable gateway is not
    // evidence that the money never moved.
    const result = await recheckPaymentCharge(tx.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settled).toBe(false);
      expect(result.status).toBe("UNDER_INVESTIGATION");
    }

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("UNDER_INVESTIGATION");
  });

  it("cannot be pointed at an order that does not exist", async () => {
    await reset();

    const res = await adminPaymentsPost(
      post("/api/admin/payments", { action: "grant", transactionId: "no-such-order" })
    );
    expect(res.status).toBe(404);

    // Nothing was created or credited by the attempt.
    expect(await prisma.videoAccess.count({ where: { viewerId } })).toBe(0);
  });

  it("rejects an unknown action rather than guessing one", async () => {
    await reset();
    const tx = await stuckCharge(300);

    const res = await adminPaymentsPost(
      post("/api/admin/payments", { action: "refund_everything", transactionId: tx.id })
    );
    expect(res.status).toBe(422);

    const still = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(still!.status).toBe("UNDER_INVESTIGATION");
  });

  // ---------------------------------------------------------------------------
  // What the PUBLIC video payload is allowed to contain
  // ---------------------------------------------------------------------------

  // This handler reads the row with `include:`, so every column is in hand and
  // anything not explicitly dropped is published. Three consequences used to
  // ship: the raw Bunny video id went to anonymous visitors, so did moderation
  // state — `isFlagged` tells the world which abuse reports landed — and so did
  // `previewUrl`, which for every demo/side-loaded row IS the full scene. The
  // client reads neither (playback and teaser arrive resolved), so a logged-out
  // visitor could stream a paid scene straight off this response. Any column
  // added to Video later would leak the same silent way, so the fields the client
  // does not need are asserted absent here.
  it("does not publish the raw Bunny id, moderation state, or the full scene URL", async () => {
    await reset();

    const { status, body } = await fetchVideo();
    expect(status).toBe(200);

    for (const leaked of [
      "previewUrl",
      "bunnyVideoId",
      "teaserClipUrl",
      "teaserBunnyVideoId",
      "isFlagged",
      "isDeleted",
      "complianceAttestedAt",
    ]) {
      expect(body.data).not.toHaveProperty(leaked);
    }
  });

  it("still publishes everything the player and paywall need", async () => {
    await reset();

    const { body } = await fetchVideo();
    for (const needed of ["title", "price", "hasAccess", "teaserUrl", "creator"]) {
      expect(body.data).toHaveProperty(needed);
    }
    // Access decisions stay server-side: the resolved URLs are the only way to
    // reach the media, which is why the raw id is safe to withhold.
    expect(body.data.creator).not.toHaveProperty("email");
  });
});
