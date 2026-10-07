// =============================================================================
// GENHUB - The payout cycle: sale -> request -> approve -> paid
//
// The whole way, from the money coming IN to the money going OUT, on one
// creator's account:
//
//   1. a viewer pays for a video from their wallet — the real purchase route —
//      and the creator keeps 70% of it, withdrawable the moment it settles;
//   2. the creator asks for a withdrawal, which earmarks the amount;
//   3. an admin approves it and then marks it paid with the receipt;
//   4. a second request is refused as below the floor and rejected, and the
//      money comes back.
//
// The sale is the first step rather than a fixture balance on purpose: the
// balance a payout draws on is the only thing that makes step 2 legitimate, and
// seeding it by hand would test the payout against a number no revenue path ever
// produces. The 70% is asserted from the sale instead of assumed.
//
// This is the only flow where money leaves the platform, and every step moves
// something the creator is watching: their available balance, or a request that
// has been accepted but not yet sent. Two things have to stay true the whole way:
//
//   1. A request EARMARKS money on acceptance — the available balance drops when
//      the request is made, not when it is approved, so the same shilling cannot
//      be requested twice;
//   2. the identity holds at every step:
//        available + open requests + paid out === lifetime earned.
//      A payout moves money between those buckets. If the sum ever grows, the
//      platform paid out money nobody earned; if it shrinks, a creator lost some.
//
// There used to be a third bucket — money held for 14 days before it could be
// withdrawn. That holding period is gone: a sale is withdrawable the moment it
// settles, so nothing is ever held and `pendingBalance` is always zero.
//
// The APPROVED -> PAID arrow is the one under test: approving said "we will send
// this" and the route then refused every later action, so an approved request
// left the queue and could never be completed — the creator's money stayed
// earmarked forever. The suite walks the whole cycle and then checks that a
// settled request cannot be settled twice.
//
// DB-backed: needs TEST_DATABASE_URL (or a local DATABASE_URL) and skips itself
// otherwise, like every other suite that moves money.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

const ctx = vi.hoisted(() => ({
  creatorId: "",
  adminId: "",
  viewerId: "",
  videoId: "",
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // The buyer. Only the purchase route uses this one; both payout routes ask
    // for a role, and answer below.
    requireAuth: async () => ({ userId: ctx.viewerId, role: "VIEWER" as const }),
    // The routes ask for different roles, so the mock answers the question it was
    // actually asked instead of flipping a shared flag.
    requireRole: async (role: string) =>
      role === "ADMIN"
        ? { userId: ctx.adminId, role: "ADMIN" as const }
        : { userId: ctx.creatorId, role: "CREATOR" as const },
  };
});

import prisma from "@/lib/db";
import { POST as purchasePost } from "@/app/api/payments/purchase/route";
import { POST as requestPayoutPost } from "@/app/api/creator/payouts/route";
import { POST as reviewPayoutPost } from "@/app/api/admin/payouts/route";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * The sale the whole cycle is built on, and the split the platform publishes:
 * the creator keeps 70%, computed the same way the server does (the platform
 * takes the rounded fee, the creator takes the remainder).
 */
const SALE_PRICE = 400_000;
const PLATFORM_PERCENT = 30;
const cutOf = (amount: number) => amount - Math.round((amount * PLATFORM_PERCENT) / 100);

/** What the sale leaves the creator: withdrawable at once, with no holding. */
const OPENING_AVAILABLE = cutOf(SALE_PRICE);
const TOTAL_EARNED = OPENING_AVAILABLE;
const MIN_PAYOUT = 30_000;

const FIRST_REQUEST = 100_000;
const SECOND_REQUEST = 120_000;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requestPayout(amount: number) {
  return requestPayoutPost(
    post("/api/creator/payouts", {
      amount,
      paymentMethod: "MPESA",
      accountDetails: "0754000000",
    })
  );
}

function review(
  payoutId: string,
  action: "APPROVED" | "PAID" | "REJECTED",
  extra: { adminNote?: string; paymentReference?: string } = {}
) {
  return reviewPayoutPost(post("/api/admin/payouts", { payoutId, action, ...extra }));
}

/** The M-Pesa code an admin reads off the confirmation SMS. */
const RECEIPT = "QGR7X8Y2Z1";

/**
 * The identity the whole cycle has to keep, asserted after every step:
 * everything the creator earned is either withdrawable, earmarked in an open
 * request, or already paid out. `pendingBalance` stays in the sum for ledger
 * completeness; there is no holding period, so it is always zero.
 */
async function balanceAndCheckIdentity() {
  const [balance, payouts] = await Promise.all([
    prisma.creatorBalance.findUnique({ where: { creatorId: ctx.creatorId } }),
    prisma.payoutRequest.findMany({ where: { creatorId: ctx.creatorId } }),
  ]);
  const sum = (statuses: string[]) =>
    payouts
      .filter((p) => statuses.includes(p.status))
      .reduce((total, p) => total + p.amount, 0);

  expect(balance).not.toBeNull();
  expect(
    balance!.availableBalance + balance!.pendingBalance + sum(["PENDING", "APPROVED"]) + sum(["PAID"])
  ).toBe(TOTAL_EARNED);
  // Lifetime earnings are lifetime: paying out never rewrites what was earned.
  expect(balance!.totalEarned).toBe(TOTAL_EARNED);
  return balance!;
}

describeDb("the payout cycle: sale -> request -> approve -> paid", () => {
  let paidRequestId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `paycreator${stamp}`;
    ctx.adminId = `payadmin${stamp}`;
    ctx.viewerId = `payviewer${stamp}`;
    ctx.videoId = `payvideo${stamp}`;

    await prisma.user.create({
      data: {
        id: ctx.creatorId,
        email: `${ctx.creatorId}@payout.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Payout Creator",
        role: "CREATOR",
        // Withdrawals are refused until identity is verified, so the fixture has
        // to be a verified creator for the rest of the cycle to happen at all.
        kycStatus: "APPROVED",
      },
    });
    await prisma.user.create({
      data: {
        id: ctx.adminId,
        email: `${ctx.adminId}@payout.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Payout Admin",
        role: "ADMIN",
      },
    });
    // The fan whose money starts the whole thing, holding exactly enough for one
    // purchase — so the wallet assertion at the end of step 1 can only pass if
    // the debit was the gross.
    await prisma.user.create({
      data: {
        id: ctx.viewerId,
        email: `${ctx.viewerId}@payout.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Payout Viewer",
        role: "VIEWER",
        walletBalance: SALE_PRICE,
      },
    });
    await prisma.video.create({
      data: {
        id: ctx.videoId,
        creatorId: ctx.creatorId,
        title: "Payout Cycle Video",
        bunnyVideoId: `paycycle-${stamp}`,
        price: SALE_PRICE,
        isPublished: true,
        teaserDuration: 15,
      },
    });
    // No seeded creatorBalance: the balance this cycle withdraws from is the one
    // the sale produces in the first test.
  });

  afterAll(async () => {
    await prisma.payoutRequest.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.adminId, ctx.viewerId] } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: ctx.adminId } });
    await prisma.transaction.deleteMany({
      where: { OR: [{ userId: ctx.viewerId }, { creatorId: ctx.creatorId }] },
    });
    await prisma.videoAccess.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.videoEarning.deleteMany({ where: { videoId: ctx.videoId } });
    await prisma.video.deleteMany({ where: { id: ctx.videoId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ctx.creatorId, ctx.adminId, ctx.viewerId] } },
    });
    await prisma.$disconnect();
  });

  // The cases share state and run in order: this is one balance, earned once and
  // then paid out, which is the thing being tested.
  it("starts with a real sale: the creator keeps 70% and can withdraw it at once", async () => {
    const res = await purchasePost(
      post("/api/payments/purchase", { videoId: ctx.videoId, method: "WALLET" })
    );
    expect(res.status).toBe(200);

    const balance = await balanceAndCheckIdentity();
    // The creator's share of what the fan paid, in the withdrawable bucket the
    // moment the sale settles: there is no holding period to wait out.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE);
    expect(balance.pendingBalance).toBe(0);
    expect(balance.totalEarned).toBe(TOTAL_EARNED);

    // The other side of the same split: the fan started with exactly one sale's
    // worth, so an empty wallet is the debit having been the gross.
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(0);

    // ...and the ledger row says what the balance says, fee and cut included.
    const purchase = await prisma.transaction.findFirst({
      where: { creatorId: ctx.creatorId, status: "SUCCESS" },
      select: { amount: true, creatorCut: true, platformFee: true },
    });
    expect(purchase?.amount).toBe(SALE_PRICE);
    expect(purchase?.creatorCut).toBe(OPENING_AVAILABLE);
    expect(purchase?.platformFee).toBe(SALE_PRICE - OPENING_AVAILABLE);
  });

  it("refuses a request below the minimum without moving a shilling", async () => {
    const res = await requestPayout(MIN_PAYOUT - 1_000);
    const body = await res.json();

    // 400: a refusal about what was asked for, not a validation of a field that
    // is missing or malformed.
    expect(res.status).toBe(400);
    expect(body.error).toContain("30,000");

    const balance = await balanceAndCheckIdentity();
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE);
    expect(await prisma.payoutRequest.count({ where: { creatorId: ctx.creatorId } })).toBe(0);
  });

  it("earmarks the money the moment a request is accepted", async () => {
    const res = await requestPayout(FIRST_REQUEST);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.status).toBe("PENDING");
    paidRequestId = body.data.id;

    // The admins hear about the request itself, not only about the balance
    // crossing the floor — which happened before the request existed, and never
    // happens at all for an account allowed to withdraw below it. A request
    // nobody is told about waits until somebody happens to open the tab.
    const alerts = await prisma.notification.findMany({
      where: { userId: ctx.adminId, title: { contains: "Withdrawal request" } },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].link).toBe("/admin");
    expect(alerts[0].message).toContain("TZS 100,000");

    const balance = await balanceAndCheckIdentity();
    // Out of the withdrawable balance immediately — a pending request is money
    // that is spoken for, and this is what stops it being requested twice.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    // Nothing is held: a payout draws on the withdrawable balance only.
    expect(balance.pendingBalance).toBe(0);
    // A payout is money leaving, not income. It is recorded as a request and an
    // audit line, never as an earnings row — a receipt here would inflate the
    // creator's revenue with their own withdrawal.
    expect(await prisma.transaction.count({ where: { creatorId: ctx.creatorId } })).toBe(0);
  });

  it("refuses a second request while one is still open", async () => {
    const res = await requestPayout(SECOND_REQUEST);

    expect(res.status).toBe(409);

    const balance = await balanceAndCheckIdentity();
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
  });

  it("keeps the money earmarked when the request is approved", async () => {
    const res = await review(paidRequestId, "APPROVED", { adminNote: "Verified the phone number" });

    expect(res.status).toBe(200);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: paidRequestId } });
    expect(payout!.status).toBe("APPROVED");

    const balance = await balanceAndCheckIdentity();
    // Approving is a promise, not a payment: nothing moves yet, and the money
    // does not go back to being withdrawable either.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    expect(balance.pendingBalance).toBe(0);
  });

  it("completes an approved request, recording the receipt", async () => {
    const res = await review(paidRequestId, "PAID", { paymentReference: RECEIPT });

    expect(res.status).toBe(200);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: paidRequestId } });
    expect(payout!.status).toBe("PAID");
    expect(payout!.processedBy).toBe(ctx.adminId);
    // The creator's own record of the payment — the whole reason a payout can be
    // marked paid rather than merely approved.
    expect(payout!.paymentReference).toBe(RECEIPT);

    const balance = await balanceAndCheckIdentity();
    // Nothing moved here — the money was earmarked when the request was made —
    // and only the paid-out total grew.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    expect(balance.pendingBalance).toBe(0);
  });

  it("refuses a second decision on a settled request", async () => {
    // A receipt is supplied deliberately: the point is that a settled request is
    // refused for being settled, not for a missing field.
    const res = await review(paidRequestId, "PAID", { paymentReference: RECEIPT });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_PROCESSED");

    const balance = await balanceAndCheckIdentity();
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
  });

  it("returns the money when a request is rejected", async () => {
    const created = await requestPayout(SECOND_REQUEST);
    const requestId = (await created.json()).data.id as string;

    const earmarked = await balanceAndCheckIdentity();
    expect(earmarked.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST - SECOND_REQUEST);

    const res = await review(requestId, "REJECTED", {
      adminNote: "Account name does not match KYC",
    });
    expect(res.status).toBe(200);

    const refunded = await balanceAndCheckIdentity();
    // Back to exactly what was withdrawable before the rejected request, not a
    // shilling more.
    expect(refunded.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: requestId } });
    expect(payout!.status).toBe("REJECTED");
    // Refusing returns money, it does not fabricate a payment: no receipt.
    expect(payout!.paymentReference).toBeNull();
  });

  it("ends with the whole lifetime earned accounted for", async () => {
    const balance = await balanceAndCheckIdentity();
    const [open, paid] = await Promise.all([
      prisma.payoutRequest.aggregate({
        where: { creatorId: ctx.creatorId, status: { in: ["PENDING", "APPROVED"] } },
        _sum: { amount: true },
      }),
      prisma.payoutRequest.aggregate({
        where: { creatorId: ctx.creatorId, status: "PAID" },
        _sum: { amount: true },
      }),
    ]);

    expect(open._sum.amount ?? 0).toBe(0);
    expect(paid._sum.amount).toBe(FIRST_REQUEST);
    expect(balance.availableBalance + balance.pendingBalance + FIRST_REQUEST).toBe(TOTAL_EARNED);
    expect(balance.pendingBalance).toBe(0);
  });
});
