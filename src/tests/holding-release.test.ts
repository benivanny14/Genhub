// =============================================================================
// GENHUB - Selling and withdrawing, across every source of creator income
//
// There is NO holding period: a sale is withdrawable the moment it settles, and
// every paying path credits `availableBalance` directly. `releaseMatureEarnings`
// survives only as the cleanup for money that was credited before that rule
// changed — it drains whatever is left in the legacy `pendingBalance` bucket.
//
// This suite runs the four real routes — a video purchase, a membership, a tip
// and a paid message — and then pins the two things that matter about the money:
//
//   1. all four credit the withdrawable balance immediately, and nothing at all
//      is left in the held bucket;
//   2. a legacy held balance is released in full, once and only once, and a
//      checkout that never settled is not income and never becomes withdrawable.
//
// DB-backed: needs TEST_DATABASE_URL (or a local DATABASE_URL) and skips itself
// otherwise, like every other suite that moves money.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

const ctx = vi.hoisted(() => ({
  viewerId: "",
  creatorId: "",
  videoId: "",
}));

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
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";
import { POST as purchasePost } from "@/app/api/payments/purchase/route";
import { POST as subscribePost } from "@/app/api/subscriptions/route";
import { POST as tipsPost } from "@/app/api/tips/route";
import { POST as messagesPost } from "@/app/api/messages/route";
import { PAID_MESSAGE_PRICE } from "@/lib/pay-message";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const VIDEO_PRICE = 5_000;
const SUB_PRICE = 1_234;
const TIP_AMOUNT = 777;
// A paid message is a fixed price (PAID_MESSAGE_PRICE), never the sender's number.
const MESSAGE_AMOUNT = PAID_MESSAGE_PRICE;
const WALLET_START = 20_000;

/** A balance some earlier version left in the held bucket. */
const LEGACY_HELD = 2_500;

/** The creator's 70%, as every route writes it. */
const cutOf = (amount: number) =>
  amount - Math.round(amount * (config.business.platformFeePercent / 100));
const CUTS = {
  video: cutOf(VIDEO_PRICE),
  subscription: cutOf(SUB_PRICE),
  tip: cutOf(TIP_AMOUNT),
  message: cutOf(MESSAGE_AMOUNT),
};
const ALL_CUTS = Object.values(CUTS).reduce((a, b) => a + b, 0);

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function balance() {
  return prisma.creatorBalance.findUnique({ where: { creatorId: ctx.creatorId } });
}

describeDb("creator earnings are withdrawable the moment they settle", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `holdcreator${stamp}`;
    ctx.viewerId = `holdviewer${stamp}`;
    ctx.videoId = `holdvideo${stamp}`;

    await prisma.user.create({
      data: {
        id: ctx.creatorId,
        email: `${ctx.creatorId}@holding.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Holding Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: ctx.viewerId,
        email: `${ctx.viewerId}@holding.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Holding Viewer",
        role: "VIEWER",
        walletBalance: WALLET_START,
      },
    });
    await prisma.creatorProfile.create({
      data: { userId: ctx.creatorId, subscriptionPrice: SUB_PRICE },
    });
    await prisma.video.create({
      data: {
        id: ctx.videoId,
        creatorId: ctx.creatorId,
        title: "Holding Test Video",
        bunnyVideoId: `holding-${stamp}`,
        price: VIDEO_PRICE,
        isPublished: true,
        teaserDuration: 15,
      },
    });
  });

  afterAll(async () => {
    await prisma.videoAccess.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.videoEarning.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.creatorSubscription.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorProfile.deleteMany({ where: { userId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.viewerId] } },
    });
    await prisma.payMessage.deleteMany({ where: { senderId: ctx.viewerId } });
    await prisma.transaction.deleteMany({
      where: { OR: [{ userId: ctx.viewerId }, { creatorId: ctx.creatorId }] },
    });
    await prisma.video.deleteMany({ where: { id: ctx.videoId } });
    await prisma.user.deleteMany({ where: { id: { in: [ctx.creatorId, ctx.viewerId] } } });
    await prisma.$disconnect();
  });

  it("earns from all four paths, and every shilling is withdrawable at once", async () => {
    expect(
      (await purchasePost(post("/api/payments/purchase", { videoId: ctx.videoId, method: "WALLET" }))).status
    ).toBe(200);
    expect(
      (await subscribePost(post("/api/subscriptions", { creatorId: ctx.creatorId }))).status
    ).toBe(201);
    expect(
      (await tipsPost(post("/api/tips", { creatorId: ctx.creatorId, amount: TIP_AMOUNT }))).status
    ).toBe(200);
    expect(
      (
        await messagesPost(
          post("/api/messages", {
            receiverId: ctx.creatorId,
            amount: MESSAGE_AMOUNT,
            content: "kazi nzuri",
          })
        )
      ).status
    ).toBe(201);

    const earned = await balance();
    // Nothing is parked: all four paths credit the withdrawable balance.
    expect(earned!.availableBalance).toBe(ALL_CUTS);
    expect(earned!.pendingBalance).toBe(0);
    expect(earned!.totalEarned).toBe(ALL_CUTS);

    // And so there is nothing for the release job to move.
    const release = await releaseMatureEarnings(ctx.creatorId);
    expect(release.released).toBe(0);
  });

  it("releases a legacy held balance in full, once and only once", async () => {
    // What a balance credited before the holding period was removed looks like.
    await prisma.creatorBalance.update({
      where: { creatorId: ctx.creatorId },
      data: { pendingBalance: LEGACY_HELD },
    });

    const result = await releaseMatureEarnings(ctx.creatorId);

    expect(result.released).toBe(LEGACY_HELD);
    expect(result.creators).toBe(1);

    const after = await balance();
    expect(after!.pendingBalance).toBe(0);
    expect(after!.availableBalance).toBe(ALL_CUTS + LEGACY_HELD);
    expect(after!.releasedTotal).toBe(LEGACY_HELD);

    // A second run has nothing left to move, and must not pay the creator twice.
    const again = await releaseMatureEarnings(ctx.creatorId);
    expect(again.released).toBe(0);
    expect((await balance())!.availableBalance).toBe(ALL_CUTS + LEGACY_HELD);
  });

  it("never credits a charge that has not settled", async () => {
    // What a checkout in progress looks like: PENDING, no creator cut, no
    // creator balance movement. If any of it were counted, a creator would be
    // paid for money that was never collected.
    await prisma.transaction.create({
      data: {
        userId: ctx.viewerId,
        creatorId: ctx.creatorId,
        videoId: ctx.videoId,
        amount: 9_000,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: "SONICPESA",
        providerRef: "hp_holding_unsettled",
        metadata: { orderId: "holding-unsettled" },
      },
    });

    const result = await releaseMatureEarnings(ctx.creatorId);

    expect(result.released).toBe(0);
    const after = await balance();
    expect(after!.availableBalance).toBe(ALL_CUTS + LEGACY_HELD);
    expect(after!.pendingBalance).toBe(0);
  });
});
