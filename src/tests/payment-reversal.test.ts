// =============================================================================
// GENHUB - Reversing a charge the customer already paid for
//
// A refund is TWO movements of money that are easy to confuse:
//   1. returning value to the customer
//   2. taking back the creator's 70%
//
// Every test here pins down one of the ways that can go wrong:
//
//   * the customer is paid TWICE (wallet credit plus a network reversal)
//   * the creator keeps money they no longer earned
//   * a balance goes negative and silently breaks the 14-day release job
//   * the same charge is refunded twice
//   * a charge we do not hold money for is refunded anyway
//
// Auth is mocked; Prisma and the balance math are real. Skips without
// DATABASE_URL.
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
import { POST as adminPaymentsPost } from "@/app/api/admin/payments/route";
import { reverseCollectedCharge } from "@/lib/services/payment-reversal.service";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describeDb("Reversing a collected charge", () => {
  let creatorId = "";
  let viewerId = "";
  let videoId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    creatorId = `revcreator${stamp}`;
    viewerId = `revviewer${stamp}`;
    videoId = `revvideo${stamp}`;

    await prisma.user.create({
      data: {
        id: creatorId,
        email: `${creatorId}@rev.test`,
        passwordHash: "rev-not-a-real-hash",
        displayName: "Rev Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: viewerId,
        email: `${viewerId}@rev.test`,
        passwordHash: "rev-not-a-real-hash",
        displayName: "Rev Viewer",
        role: "VIEWER",
        walletBalance: 50_000,
      },
    });
    await prisma.video.create({
      data: {
        id: videoId,
        title: "Rev video",
        price: 1_000,
        teaserDuration: 30,
        bunnyVideoId: `revbunny${stamp}`,
        creatorId,
      },
    });

    ctx.viewerId = viewerId;
    ctx.adminId = `revadmin${stamp}`;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [viewerId, creatorId] } } });
    await prisma.transaction.deleteMany({ where: { userId: viewerId } });
    await prisma.videoAccess.deleteMany({ where: { viewerId } });
    await prisma.videoEarning.deleteMany({ where: { videoId } });
    await prisma.creatorSubscription.deleteMany({ where: { viewerId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId } });
    await prisma.video.deleteMany({ where: { id: videoId } });
    await prisma.user.deleteMany({ where: { id: { in: [creatorId, viewerId] } } });
    await prisma.$disconnect();
  });

  async function reset() {
    await prisma.notification.deleteMany({ where: { userId: { in: [viewerId, creatorId] } } });
    await prisma.transaction.deleteMany({ where: { userId: viewerId } });
    await prisma.videoAccess.deleteMany({ where: { viewerId, videoId } });
    await prisma.videoEarning.deleteMany({ where: { videoId } });
    await prisma.creatorSubscription.deleteMany({ where: { viewerId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId } });
    await prisma.user.update({
      where: { id: viewerId },
      data: { walletBalance: 50_000 },
    });
    await prisma.video.update({ where: { id: videoId }, data: { purchaseCount: 0 } });
  }

  /** A settled 70/30 purchase: TZS 1,000 paid, TZS 700 to the creator. */
  async function settledPurchase(opts?: { daysAgo?: number }) {
    const createdAt = new Date(Date.now() - (opts?.daysAgo ?? 0) * 86_400_000);

    // Mirror exactly what the settlement path does for each sale: +700 into the
    // holding period. A helper that only seeded the FIRST purchase would hide
    // any clawback bug that depends on how much is held.
    await prisma.creatorBalance.upsert({
      where: { creatorId },
      create: {
        creatorId,
        pendingBalance: 700,
        availableBalance: 0,
        totalEarned: 700,
      },
      update: {
        pendingBalance: { increment: 700 },
        totalEarned: { increment: 700 },
      },
    });
    await prisma.videoEarning.upsert({
      where: { videoId },
      create: { videoId, totalEarned: 700, totalPurchases: 1 },
      update: {
        totalEarned: { increment: 700 },
        totalPurchases: { increment: 1 },
      },
    });
    await prisma.videoAccess.upsert({
      where: { viewerId_videoId: { viewerId, videoId } },
      create: { viewerId, videoId },
      update: {},
    });
    await prisma.video.update({
      where: { id: videoId },
      data: { purchaseCount: { increment: 1 } },
    });

    return prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount: 1_000,
        platformFee: 300,
        creatorCut: 700,
        type: "PPV_PURCHASE",
        status: "SUCCESS",
        gateway: "HARAKAPAY",
        providerRef: `hp_rev_${Math.random().toString(36).slice(2, 10)}`,
        createdAt,
      },
    });
  }

  async function stuckTopUp(amount = 1_000) {
    return prisma.transaction.create({
      data: {
        userId: viewerId,
        amount,
        type: "WALLET_TOPUP",
        status: "UNDER_INVESTIGATION",
        gateway: "HARAKAPAY",
        providerRef: `hp_rev_top_${Math.random().toString(36).slice(2, 10)}`,
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. The happy path: wallet credit + full 70% clawback
  // ---------------------------------------------------------------------------

  it("credits the customer and takes the whole 70% back from the creator", async () => {
    await reset();
    const tx = await settledPurchase();

    const before = await prisma.user.findUnique({ where: { id: viewerId } });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
      reason: "the creator withdrew this video",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.walletCredited).toBe(1_000);
    expect(result.clawedBackPending).toBe(700);
    expect(result.clawedBackAvailable).toBe(0);
    expect(result.shortfall).toBe(0);
    expect(result.revoked).toBe("VIDEO_ACCESS");

    // Customer is made whole, immediately and spendably.
    const after = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(after!.walletBalance - before!.walletBalance).toBe(1_000);

    // Creator no longer holds money they did not earn.
    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
    expect(balance!.availableBalance).toBe(0);
    expect(balance!.totalEarned).toBe(0);

    // Per-video counters follow the books.
    const earning = await prisma.videoEarning.findUnique({ where: { videoId } });
    expect(earning!.totalEarned).toBe(0);
    expect(earning!.totalPurchases).toBe(0);
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { purchaseCount: true },
    });
    expect(video!.purchaseCount).toBe(0);

    // A refunded purchase does not leave the goods behind.
    const access = await prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId, videoId } },
    });
    expect(access).toBeNull();
  });

  it("records who did it, where the money went and why", async () => {
    await reset();
    const tx = await settledPurchase();

    await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
      reason: "customer could not watch it",
    });

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("REFUNDED");

    const meta = after!.metadata as Record<string, unknown>;
    expect(meta.refunded).toBe(true);
    expect(meta.refundedBy).toBe(ctx.adminId);
    expect(meta.refundDestination).toBe("WALLET");
    expect(meta.refundReason).toBe("customer could not watch it");
    expect(meta.refundedAmount).toBe(1_000);
    expect(meta.clawedBackPending).toBe(700);
    // Whether the charge had settled is what explains the clawback (or its
    // absence) to whoever reads this row later.
    expect(meta.settledBefore).toBe(true);
    // No shortfall key at all when everything was recovered — an explicit 0
    // would read like a loss on the books.
    expect(meta.refundShortfall).toBeUndefined();
    expect(typeof meta.refundedAt).toBe("string");
  });

  it("tells both sides, with the money's destination spelled out", async () => {
    await reset();
    const tx = await settledPurchase();

    await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    const customer = await prisma.notification.findFirst({
      where: { userId: viewerId },
      orderBy: { createdAt: "desc" },
    });
    expect(customer!.message).toContain("wallet");
    expect(customer!.message.toLowerCase()).toContain("available to spend");

    const creator = await prisma.notification.findFirst({
      where: { userId: creatorId },
      orderBy: { createdAt: "desc" },
    });
    expect(creator!.type).toBe("warning");
    expect(creator!.message).toContain("refunded to the customer");
    // The creator must be able to see exactly what was taken, and off what.
    expect(creator!.message).toContain("TZS 1,000");
    expect(creator!.message).toContain("TZS 700 share was taken back from your balance");
  });

  // ---------------------------------------------------------------------------
  // 2. Where the clawback comes from
  // ---------------------------------------------------------------------------

  it("takes from the available balance when the holding period already ended", async () => {
    await reset();
    const tx = await settledPurchase();

    // The 700 has already matured out of holding.
    await prisma.creatorBalance.update({
      where: { creatorId },
      data: { pendingBalance: 0, availableBalance: 700 },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clawedBackPending).toBe(0);
    expect(result.clawedBackAvailable).toBe(700);
    expect(result.shortfall).toBe(0);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
    expect(balance!.availableBalance).toBe(0);
  });

  it("records a shortfall instead of going negative when the money is already gone", async () => {
    await reset();
    const tx = await settledPurchase();

    // Already released AND withdrawn: nothing left to claw back.
    await prisma.creatorBalance.update({
      where: { creatorId },
      data: { pendingBalance: 0, availableBalance: 0 },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clawedBackPending).toBe(0);
    expect(result.clawedBackAvailable).toBe(0);
    expect(result.shortfall).toBe(700);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    // NEVER negative: the release job's optimistic lock requires
    // pendingBalance >= amount, and a negative balance would quietly corrupt it.
    expect(balance!.pendingBalance).toBe(0);
    expect(balance!.availableBalance).toBe(0);

    const meta = (await prisma.transaction.findUnique({ where: { id: tx.id } }))!
      .metadata as Record<string, unknown>;
    expect(meta.refundShortfall).toBe(700);
  });

  // ---------------------------------------------------------------------------
  // 2b. A charge that never settled has nothing to claw back
  // ---------------------------------------------------------------------------
  // An UNDER_INVESTIGATION charge never went through settlement, so the creator
  // was never credited: creatorCut is null, there is no videoEarning row and
  // pendingBalance never moved. Refunding it must not invent a debt.

  it("leaves the creator completely alone when the charge never settled", async () => {
    await reset();
    await prisma.creatorBalance.create({
      data: { creatorId, pendingBalance: 3_500, availableBalance: 1_000, totalEarned: 4_500 },
    });
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount: 1_000,
        type: "PPV_PURCHASE",
        status: "UNDER_INVESTIGATION",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_investigating",
        metadata: { investigation: true, reason: "gateway_never_settled" },
      },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
      reason: "customer could not be reached",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.settledBefore).toBe(false);
    expect(result.clawedBackPending).toBe(0);
    expect(result.clawedBackAvailable).toBe(0);
    expect(result.shortfall).toBe(0);

    // The customer is still made whole from our side...
    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(51_000);

    // ...and the creator's money is untouched, to the shilling.
    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(3_500);
    expect(balance!.availableBalance).toBe(1_000);
    expect(balance!.totalEarned).toBe(4_500);

    // No phantom earnings reversal either.
    expect(await prisma.videoEarning.findUnique({ where: { videoId } })).toBeNull();
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { purchaseCount: true },
    });
    // purchaseCount was never incremented for this charge, so it must not fall.
    expect(video!.purchaseCount).toBe(0);

    const meta = (await prisma.transaction.findUnique({ where: { id: tx.id } }))!
      .metadata as Record<string, unknown>;
    expect(meta.settledBefore).toBe(false);
    // The investigation history survives the reversal that closed it out.
    expect(meta.reason).toBe("gateway_never_settled");
    expect(meta.investigation).toBe(false);
  });

  it("does not claim to have revoked access it never granted", async () => {
    await reset();
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount: 1_000,
        type: "PPV_PURCHASE",
        status: "UNDER_INVESTIGATION",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_no_access",
        metadata: { investigation: true },
      },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // There was no access row to delete, so the audit trail must say NOTHING
    // rather than claim the customer lost something they never had.
    expect(result.revoked).toBe("NOTHING");
  });

  it("still takes the 70% back when the charge had settled first", async () => {
    await reset();
    // The admin granted it (so the creator was credited), then had to reverse it
    // after all. Now the clawback is real.
    const tx = await settledPurchase();

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settledBefore).toBe(true);
    expect(result.clawedBackPending).toBe(700);
  });

  // ---------------------------------------------------------------------------
  // 3. The books must still balance for the 14-day release job
  // ---------------------------------------------------------------------------

  it("stops the creator's future earnings from double-paying a reversed sale", async () => {
    await reset();

    // An old, matured sale that has already been released to the creator.
    const old = await settledPurchase({ daysAgo: 30 });
    const firstRelease = await releaseMatureEarnings(creatorId);
    expect(firstRelease.released).toBe(700);

    let balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
    expect(balance!.availableBalance).toBe(700);

    // Now reverse it. The 700 comes back out of the available balance.
    await reverseCollectedCharge({
      transactionId: old.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.availableBalance).toBe(0);

    // The release job recomputes matured earnings as SUM(creatorCut) WHERE
    // SUCCESS — so the REFUNDED row simply vanished from the sum, and the job
    // must not pay the creator again for money that was returned.
    expect((await prisma.transaction.findUnique({ where: { id: old.id } }))!.status).toBe(
      "REFUNDED"
    );
    const replay = await releaseMatureEarnings(creatorId);
    expect(replay.released).toBe(0);

    // Two fresh matured sales: the reversal is absorbed before anything is
    // released again, so the creator cannot keep both the refund and the money.
    await settledPurchase({ daysAgo: 30 });
    await settledPurchase({ daysAgo: 30 });

    const afterRefund = await releaseMatureEarnings(creatorId);
    // Matured 700 x 2 = 1,400, releasedTotal still 700 -> exactly 700 releases.
    expect(afterRefund.released).toBe(700);

    balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(700);
    expect(balance!.availableBalance).toBe(700);
  });

  it("drops a reversed charge out of platform revenue", async () => {
    await reset();
    const tx = await settledPurchase();

    const sumBefore = await prisma.transaction.aggregate({
      where: { creatorId, status: "SUCCESS" },
      _sum: { platformFee: true, creatorCut: true },
    });
    expect(sumBefore._sum.platformFee).toBe(300);

    await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    // Admin → Overview sums status: "SUCCESS", so REFUNDED is excluded and the
    // revenue numbers correct themselves without a separate adjustment.
    const sumAfter = await prisma.transaction.aggregate({
      where: { creatorId, status: "SUCCESS" },
      _sum: { platformFee: true, creatorCut: true },
    });
    expect(sumAfter._sum.platformFee ?? 0).toBe(0);
    expect(sumAfter._sum.creatorCut ?? 0).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 4. The double-pay guards
  // ---------------------------------------------------------------------------

  it("refuses a wallet refund of a top-up, which would credit the same money twice", async () => {
    await reset();
    const tx = await stuckTopUp();

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wallet_refund_of_topup");

    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("UNDER_INVESTIGATION");

    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(50_000);
  });

  it("takes a top-up credit back out of the wallet for a network reversal", async () => {
    await reset();
    const tx = await stuckTopUp(1_000);

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "GATEWAY",
      actorId: ctx.adminId,
      gatewayRef: "REV-2026-000123",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.walletDebited).toBe(1_000);
    expect(result.walletCredited).toBe(0);
    expect(result.revoked).toBe("TOPUP_CREDIT");

    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(49_000);
  });

  it("refuses to reverse a top-up the customer has already spent", async () => {
    await reset();
    await prisma.user.update({ where: { id: viewerId }, data: { walletBalance: 200 } });
    const tx = await stuckTopUp(1_000);

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "GATEWAY",
      actorId: ctx.adminId,
      gatewayRef: "REV-2026-000124",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_wallet");

    // Nothing moved at all — no partial debit, no REFUNDED record.
    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(200);
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("UNDER_INVESTIGATION");
  });

  it("requires the HarakaPay reference before claiming a network reversal", async () => {
    await reset();
    const tx = await settledPurchase();

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "GATEWAY",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gateway_ref_required");

    // Untouched: no record of a reversal we cannot prove happened.
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
    expect((await prisma.user.findUnique({ where: { id: viewerId } }))!.walletBalance).toBe(
      50_000
    );
  });

  it("records the reference and leaves the wallet alone for a network reversal", async () => {
    await reset();
    const tx = await settledPurchase();

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "GATEWAY",
      actorId: ctx.adminId,
      gatewayRef: "REV-2026-000999",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.walletCredited).toBe(0);
    expect(result.clawedBackPending).toBe(700);

    // The money goes back to the phone, so the wallet must NOT also be credited.
    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(50_000);

    const meta = (await prisma.transaction.findUnique({ where: { id: tx.id } }))!
      .metadata as Record<string, unknown>;
    expect(meta.gatewayReversalRef).toBe("REV-2026-000999");

    // And the customer is told to expect it on their phone, not in the wallet.
    const notice = await prisma.notification.findFirst({
      where: { userId: viewerId },
      orderBy: { createdAt: "desc" },
    });
    expect(notice!.message).toContain("phone");
    expect(notice!.message).toContain("not show in your wallet");
  });

  // ---------------------------------------------------------------------------
  // 5. Refunding the same money twice, from either direction
  // ---------------------------------------------------------------------------

  it("cannot refund the same charge twice", async () => {
    await reset();
    const tx = await settledPurchase();

    const first = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });
    expect(first.ok).toBe(true);

    const second = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_refunded");

    // The customer was paid exactly once.
    const user = await prisma.user.findUnique({ where: { id: viewerId } });
    expect(user!.walletBalance).toBe(51_000);
  });

  it("refuses to refund money it does not hold", async () => {
    await reset();

    for (const status of ["PENDING", "FAILED"] as const) {
      const tx = await prisma.transaction.create({
        data: {
          userId: viewerId,
          videoId,
          creatorId,
          amount: 1_000,
          type: "PPV_PURCHASE",
          status,
          gateway: "HARAKAPAY",
          providerRef: `hp_not_held_${status}`,
        },
      });

      const result = await reverseCollectedCharge({
        transactionId: tx.id,
        destination: "WALLET",
        actorId: ctx.adminId,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not_reversible");
        expect(result.status).toBe(status);
      }

      // A PENDING charge may never have collected anything — refunding it would
      // hand out money that was never received.
      const user = await prisma.user.findUnique({ where: { id: viewerId } });
      expect(user!.walletBalance).toBe(50_000);
    }
  });

  it("does not revoke access the customer paid for separately", async () => {
    await reset();
    const first = await settledPurchase();
    // They bought it again; only one of the two charges is being refunded.
    await settledPurchase();

    await reverseCollectedCharge({
      transactionId: first.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    // Losing the video because of the refunded charge would be wrong.
    const access = await prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId, videoId } },
    });
    expect(access).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 6. Other transaction types
  // ---------------------------------------------------------------------------

  it("ends the membership and stops it renewing", async () => {
    await reset();
    await prisma.creatorSubscription.create({
      data: {
        viewerId,
        creatorId,
        price: 5_000,
        expiresAt: new Date(Date.now() + 20 * 86_400_000),
        isActive: true,
        autoRenew: true,
      },
    });
    await prisma.creatorBalance.create({
      data: {
        creatorId,
        pendingBalance: 3_500,
        availableBalance: 0,
        totalEarned: 3_500,
      },
    });
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        creatorId,
        amount: 5_000,
        platformFee: 1_500,
        creatorCut: 3_500,
        type: "SUBSCRIPTION",
        status: "SUCCESS",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_sub",
      },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revoked).toBe("MEMBERSHIP");

    const sub = await prisma.creatorSubscription.findUnique({
      where: { viewerId_creatorId: { viewerId, creatorId } },
    });
    expect(sub!.isActive).toBe(false);
    // autoRenew must go off too, or the cron would charge for a refunded
    // membership all over again.
    expect(sub!.autoRenew).toBe(false);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
  });

  it("claws back a tip written before the split in full", async () => {
    await reset();
    await prisma.creatorBalance.create({
      data: { creatorId, pendingBalance: 2_000, availableBalance: 0, totalEarned: 2_000 },
    });
    // A tip row from before the 70/30 split was recorded: creatorCut === amount
    // and no platformFee. Those rows are still in the ledger, and reversing one
    // has to take back everything the creator was given.
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        creatorId,
        amount: 2_000,
        platformFee: 0,
        creatorCut: 2_000,
        type: "TIP",
        status: "SUCCESS",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_tip",
      },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clawedBackPending).toBe(2_000);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
  });

  it("claws back only the creator's 70% of a tip written after the split", async () => {
    await reset();
    await prisma.creatorBalance.create({
      data: { creatorId, pendingBalance: 1_400, availableBalance: 0, totalEarned: 1_400 },
    });
    // What /api/tips writes now: the customer pays 2,000, the platform takes 600
    // and the creator's holding holds 1,400.
    const tx = await prisma.transaction.create({
      data: {
        userId: viewerId,
        creatorId,
        amount: 2_000,
        platformFee: 600,
        creatorCut: 1_400,
        type: "TIP",
        status: "SUCCESS",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_tip_split",
      },
    });

    const result = await reverseCollectedCharge({
      transactionId: tx.id,
      destination: "WALLET",
      actorId: ctx.adminId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The customer gets the whole 2,000 back; the creator gives back exactly what
    // they were credited, and the platform's 600 is its own loss — the same
    // treatment a refunded video purchase gets.
    expect(result.walletCredited).toBe(2_000);
    expect(result.clawedBackPending).toBe(1_400);
    expect(result.shortfall).toBe(0);

    const balance = await prisma.creatorBalance.findUnique({ where: { creatorId } });
    expect(balance!.pendingBalance).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 7. Through the admin API, including the error codes the UI relies on
  // ---------------------------------------------------------------------------

  it("exposes the reversal through the admin API with a complete result", async () => {
    await reset();
    const tx = await settledPurchase();

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: tx.id,
        destination: "WALLET",
        reason: "delivery failed",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.amount).toBe(1_000);
    expect(body.data.destination).toBe("WALLET");
    expect(body.data.walletCredited).toBe(1_000);
    expect(body.data.clawedBack).toBe(700);
    expect(body.data.shortfall).toBe(0);
    expect(body.data.revoked).toBe("VIDEO_ACCESS");
  });

  it("reports the shortfall in the API response when the creator was already paid", async () => {
    await reset();
    const tx = await settledPurchase();
    await prisma.creatorBalance.update({
      where: { creatorId },
      data: { pendingBalance: 0, availableBalance: 0 },
    });

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: tx.id,
        destination: "WALLET",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.shortfall).toBe(700);
    expect(body.data.message).toContain("platform loss");
  });

  it("returns the conflict and validation codes the UI depends on", async () => {
    await reset();
    const tx = await settledPurchase();

    // Missing gateway reference.
    const noRef = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: tx.id,
        destination: "GATEWAY",
      })
    );
    expect(noRef.status).toBe(400);
    expect((await noRef.json()).code).toBe("GATEWAY_REF_REQUIRED");

    // Top-up refunded to the wallet.
    const topUp = await stuckTopUp(500);
    const wrongWay = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: topUp.id,
        destination: "WALLET",
      })
    );
    expect(wrongWay.status).toBe(400);
    expect((await wrongWay.json()).code).toBe("WALLET_REFUND_OF_TOPUP");

    // Not reversible.
    const pending = await prisma.transaction.create({
      data: {
        userId: viewerId,
        videoId,
        creatorId,
        amount: 100,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "hp_rev_pending",
      },
    });
    const notRev = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: pending.id,
        destination: "WALLET",
      })
    );
    expect(notRev.status).toBe(409);
    expect((await notRev.json()).code).toBe("NOT_REVERSIBLE");

    // Unknown order.
    const missing = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: "no-such-order",
        destination: "WALLET",
      })
    );
    expect(missing.status).toBe(404);
  });

  it("rejects a destination it does not understand", async () => {
    await reset();
    const tx = await settledPurchase();

    const res = await adminPaymentsPost(
      post("/api/admin/payments", {
        action: "refund",
        transactionId: tx.id,
        destination: "BITCOIN",
      })
    );

    expect(res.status).toBe(422);
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    expect(after!.status).toBe("SUCCESS");
  });
});
