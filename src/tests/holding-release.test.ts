// =============================================================================
// GENHUB - The 14-day holding, across every source of creator income
//
// `releaseMatureEarnings` moves a creator's money out of the holding period. It
// does not know what a video sale is: it reads the ledger — SUCCESS charges with
// a `creatorCut`, older than the holding window — which is exactly why all four
// ways to pay a creator have to write the same shape. Tips and paid messages
// were the ones that did not (they paid 100% and wrote a different cut), and no
// test would have noticed, because nothing checked the four together.
//
// This suite runs the four real routes — a video purchase, a membership, a tip
// and a paid message — and then works the holding clock:
//
//   1. nothing is payable while every charge is inside the window;
//   2. each charge matures on its OWN clock. Three aged rows release together
//      while a young one stays held, so the job is not "this creator is ready";
//   3. the last charge releases when its own window closes, and the balance
//      settles: pending + available === totalEarned, released once and only once;
//   4. a checkout that never settled is not income and is never released.
//
// DB-backed: needs TEST_DATABASE_URL (or a local DATABASE_URL) and skips itself
// otherwise, like every other suite that moves money.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Transaction } from "@prisma/client";

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

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const DAY = 86_400_000;

const VIDEO_PRICE = 5_000;
const SUB_PRICE = 1_234;
const TIP_AMOUNT = 777;
const MESSAGE_AMOUNT = 333;
const WALLET_START = 20_000;

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

/** The transaction a path wrote, identified by the amount it charged. */
async function ledgerRow(amount: number): Promise<Transaction> {
  const row = await prisma.transaction.findFirst({
    where: {
      userId: ctx.viewerId,
      creatorId: ctx.creatorId,
      amount,
      status: "SUCCESS",
    },
  });
  expect(row).not.toBeNull();
  return row!;
}

/** Move one charge back past the holding window, the way time would. */
async function age(row: Transaction, days = config.business.holdingPeriodDays + 1) {
  await prisma.transaction.update({
    where: { id: row.id },
    data: { createdAt: new Date(Date.now() - days * DAY) },
  });
}

async function balance() {
  return prisma.creatorBalance.findUnique({ where: { creatorId: ctx.creatorId } });
}

describeDb("the 14-day holding releases every source the same way", () => {
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

  // The four cases below share state and run in order: each one moves the clock
  // a little further forward.
  it("earns from all four paths, and pays out none of it yet", async () => {
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

    const held = await balance();
    expect(held!.pendingBalance).toBe(ALL_CUTS);
    expect(held!.totalEarned).toBe(ALL_CUTS);
    expect(held!.availableBalance).toBe(0);

    // Every charge is inside the window, so there is nothing to release —
    // regardless of which of the four paths wrote it.
    const early = await releaseMatureEarnings(ctx.creatorId);
    expect(early.released).toBe(0);
    const after = await balance();
    expect(after!.pendingBalance).toBe(ALL_CUTS);
    expect(after!.availableBalance).toBe(0);
  });

  it("releases each charge on its own clock, not the creator's", async () => {
    // Three sources age past the window; the paid message does not.
    await age(await ledgerRow(VIDEO_PRICE));
    await age(await ledgerRow(SUB_PRICE));
    await age(await ledgerRow(TIP_AMOUNT));

    const result = await releaseMatureEarnings(ctx.creatorId);

    const matured = CUTS.video + CUTS.subscription + CUTS.tip;
    expect(result.released).toBe(matured);
    expect(result.creators).toBe(1);

    const held = await balance();
    expect(held!.availableBalance).toBe(matured);
    expect(held!.pendingBalance).toBe(CUTS.message);
    expect(held!.releasedTotal).toBe(matured);
    // Releasing is not earning: the two buckets still add up to the lifetime.
    expect(held!.pendingBalance + held!.availableBalance).toBe(held!.totalEarned);
  });

  it("releases the last source when its own window closes, and only once", async () => {
    await age(await ledgerRow(MESSAGE_AMOUNT));

    const result = await releaseMatureEarnings(ctx.creatorId);

    expect(result.released).toBe(CUTS.message);
    const settled = await balance();
    expect(settled!.availableBalance).toBe(ALL_CUTS);
    expect(settled!.pendingBalance).toBe(0);
    expect(settled!.releasedTotal).toBe(ALL_CUTS);
    expect(settled!.pendingBalance + settled!.availableBalance).toBe(settled!.totalEarned);

    // A second run has nothing left to move, and must not pay the creator twice.
    const again = await releaseMatureEarnings(ctx.creatorId);
    expect(again.released).toBe(0);
    const after = await balance();
    expect(after!.availableBalance).toBe(ALL_CUTS);
  });

  it("never releases a charge that has not settled", async () => {
    // What a checkout in progress looks like: PENDING, no creator cut, no
    // creator balance movement. If the release job counted it, a creator would
    // be paid for money that was never collected.
    await prisma.transaction.create({
      data: {
        userId: ctx.viewerId,
        creatorId: ctx.creatorId,
        videoId: ctx.videoId,
        amount: 9_000,
        type: "PPV_PURCHASE",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "hp_holding_unsettled",
        metadata: { orderId: "holding-unsettled" },
      },
    });
    // Old enough to mature by date alone — the status is the only thing stopping it.
    await prisma.transaction.updateMany({
      where: { providerRef: "hp_holding_unsettled" },
      data: { createdAt: new Date(Date.now() - 30 * DAY) },
    });

    const result = await releaseMatureEarnings(ctx.creatorId);

    expect(result.released).toBe(0);
    const after = await balance();
    expect(after!.availableBalance).toBe(ALL_CUTS);
    expect(after!.pendingBalance).toBe(0);
  });
});
