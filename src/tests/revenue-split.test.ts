// =============================================================================
// GENHUB - One revenue split, four ways to pay
//
// The platform's public promise is 70/30: /about says creators keep 70% of every
// sale, subscription and tip, and the paid message is charged the same way. That
// promise is kept in four different routes, each with its own debit, its own
// transaction row and its own creator credit — and a copy of the arithmetic is
// exactly how one of them ends up a shilling (or a whole 30%) apart from the
// others. It has already happened twice: tips paid the creator in full, and paid
// messages did too, while /about said 70%.
//
// So this suite does not test the split of one route. It runs all four real
// routes against the real database, in order, and asserts that:
//
//   1. every path records `platformFee` + `creatorCut`, both non-null, summing
//      back to the amount the customer actually paid;
//   2. the creator's 14-day holding receives the cuts and nothing else;
//   3. the customer's wallet is debited the gross, so the ledger closes —
//      cuts + fees === what left the wallet.
//
// DB-backed: it needs TEST_DATABASE_URL (or a local DATABASE_URL) and skips
// itself otherwise, like every other suite that moves money.
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
import { POST as purchasePost } from "@/app/api/payments/purchase/route";
import { POST as subscribePost } from "@/app/api/subscriptions/route";
import { POST as tipsPost } from "@/app/api/tips/route";
import { POST as messagesPost } from "@/app/api/messages/route";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Deliberately the numbers from the promise itself, not from config: if the
 * published rate ever changes, this suite has to be the thing that argues about
 * it rather than quietly following along.
 */
const PLATFORM_PERCENT = 30;
const feeOf = (amount: number) => Math.round((amount * PLATFORM_PERCENT) / 100);
const cutOf = (amount: number) => amount - feeOf(amount);

const VIDEO_PRICE = 5_000;
const SUB_PRICE = 1_234; // not a multiple of 10: the rounding has to land somewhere
const TIP_AMOUNT = 777;
const MESSAGE_AMOUNT = 333;
const WALLET_START = 20_000;
const GROSS = VIDEO_PRICE + SUB_PRICE + TIP_AMOUNT + MESSAGE_AMOUNT;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The transaction a path wrote, found by the amount it charged — the four
 * amounts differ, and two of the four paths write the same `TIP` type, so the
 * amount is the one column that identifies a path on its own.
 */
async function ledgerRow(amount: number): Promise<Transaction | null> {
  return prisma.transaction.findFirst({
    where: {
      userId: ctx.viewerId,
      creatorId: ctx.creatorId,
      amount,
      status: "SUCCESS",
    },
  });
}

function expectSplit(row: Transaction, amount: number) {
  expect(row.platformFee).not.toBeNull();
  expect(row.creatorCut).not.toBeNull();
  expect(row.platformFee).toBe(feeOf(amount));
  expect(row.creatorCut).toBe(cutOf(amount));
  // The two halves are the amount, always: a rounding rule that took 30% of the
  // fee AND 30% of the remainder would leave the creator with less than 70%.
  expect((row.platformFee ?? 0) + (row.creatorCut ?? 0)).toBe(row.amount);
}

describeDb("every payment path writes the same 70/30 split", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `splitcreator${stamp}`;
    ctx.viewerId = `splitviewer${stamp}`;
    ctx.videoId = `splitvideo${stamp}`;

    await prisma.user.create({
      data: {
        id: ctx.creatorId,
        email: `${ctx.creatorId}@split.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Split Creator",
        role: "CREATOR",
      },
    });
    await prisma.user.create({
      data: {
        id: ctx.viewerId,
        email: `${ctx.viewerId}@split.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Split Viewer",
        role: "VIEWER",
        walletBalance: WALLET_START,
      },
    });
    // The membership price comes from the creator's profile, so it has to be
    // explicit here — otherwise the fallback price would be the thing under test.
    await prisma.creatorProfile.create({
      data: { userId: ctx.creatorId, subscriptionPrice: SUB_PRICE },
    });
    await prisma.video.create({
      data: {
        id: ctx.videoId,
        creatorId: ctx.creatorId,
        title: "Split Test Video",
        bunnyVideoId: `split-${stamp}`,
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

  it("splits a video purchase", async () => {
    const res = await purchasePost(
      post("/api/payments/purchase", { videoId: ctx.videoId, method: "WALLET" })
    );
    expect(res.status).toBe(200);

    const row = await ledgerRow(VIDEO_PRICE);
    expect(row).not.toBeNull();
    expect(row!.type).toBe("PPV_PURCHASE");
    expectSplit(row!, VIDEO_PRICE);
  });

  it("splits a membership", async () => {
    const res = await subscribePost(
      post("/api/subscriptions", { creatorId: ctx.creatorId })
    );
    expect(res.status).toBe(201);

    const row = await ledgerRow(SUB_PRICE);
    expect(row).not.toBeNull();
    expect(row!.type).toBe("SUBSCRIPTION");
    expectSplit(row!, SUB_PRICE);
  });

  it("splits a tip", async () => {
    const res = await tipsPost(
      post("/api/tips", { creatorId: ctx.creatorId, amount: TIP_AMOUNT })
    );
    expect(res.status).toBe(200);

    const row = await ledgerRow(TIP_AMOUNT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe("TIP");
    // A tip and a paid message are both TIP transactions. Only the message marks
    // itself, which is what keeps the two from being read as one thing.
    expect((row!.metadata as { method?: string } | null)?.method).toBeUndefined();
    expectSplit(row!, TIP_AMOUNT);
  });

  it("splits a paid message, and records that it was one", async () => {
    const res = await messagesPost(
      post("/api/messages", {
        receiverId: ctx.creatorId,
        amount: MESSAGE_AMOUNT,
        content: "asante kwa kazi yako",
      })
    );
    expect(res.status).toBe(201);

    const row = await ledgerRow(MESSAGE_AMOUNT);
    expect(row).not.toBeNull();
    expect(row!.type).toBe("TIP");
    expect((row!.metadata as { method?: string } | null)?.method).toBe("pay_message");
    expectSplit(row!, MESSAGE_AMOUNT);
  });

  // Runs last on purpose: it reads the state the four paths above left behind,
  // which is the whole point — the four credits have to add up as one balance.
  it("leaves the creator holding exactly the four cuts, and closes the ledger", async () => {
    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });
    const cuts = [VIDEO_PRICE, SUB_PRICE, TIP_AMOUNT, MESSAGE_AMOUNT].map(cutOf);
    const fees = [VIDEO_PRICE, SUB_PRICE, TIP_AMOUNT, MESSAGE_AMOUNT].map(feeOf);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    expect(balance).not.toBeNull();
    expect(balance!.pendingBalance).toBe(sum(cuts));
    expect(balance!.totalEarned).toBe(sum(cuts));
    // Nothing has matured yet, so none of it is payable.
    expect(balance!.availableBalance).toBe(0);

    // The ledger closes: every shilling the customer paid is either the creator's
    // cut or the platform's fee, and the wallet is short by exactly the gross.
    expect(sum(cuts) + sum(fees)).toBe(GROSS);
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(WALLET_START - GROSS);
  });
});
