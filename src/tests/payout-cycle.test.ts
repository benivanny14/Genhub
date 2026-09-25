// =============================================================================
// GENHUB - The payout cycle: request -> approve -> paid
//
// This is the only flow where money leaves the platform, and every step moves
// something the creator is watching: their available balance, their held
// balance, or a request that has been accepted but not yet sent. Three things
// have to stay true the whole way:
//
//   1. A request EARMARKS money on acceptance — the available balance drops when
//      the request is made, not when it is approved, so the same shilling cannot
//      be requested twice;
//   2. the held balance is never touched. Payouts pay out matured earnings;
//      money still inside the 14-day holding is not the creator's to withdraw;
//   3. the identity holds at every step:
//        available + held + open requests + paid out === lifetime earned.
//      A payout moves money between those buckets. If the sum ever grows, the
//      platform paid out money nobody earned; if it shrinks, a creator lost some.
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
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: ctx.creatorId, role: "CREATOR" as const }),
    // The two payout routes ask for different roles, so the mock answers the
    // question it was actually asked instead of flipping a shared flag.
    requireRole: async (role: string) =>
      role === "ADMIN"
        ? { userId: ctx.adminId, role: "ADMIN" as const }
        : { userId: ctx.creatorId, role: "CREATOR" as const },
  };
});

import prisma from "@/lib/db";
import { POST as requestPayoutPost } from "@/app/api/creator/payouts/route";
import { POST as reviewPayoutPost } from "@/app/api/admin/payouts/route";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const OPENING_AVAILABLE = 250_000;
const HELD = 40_000;
const TOTAL_EARNED = OPENING_AVAILABLE + HELD;
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

function review(payoutId: string, action: "APPROVED" | "PAID" | "REJECTED", adminNote?: string) {
  return reviewPayoutPost(post("/api/admin/payouts", { payoutId, action, adminNote }));
}

/**
 * The identity the whole cycle has to keep, asserted after every step:
 * everything the creator earned is either withdrawable, still held, earmarked in
 * an open request, or already paid out.
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

describeDb("the payout cycle: request -> approve -> paid", () => {
  let paidRequestId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `paycreator${stamp}`;
    ctx.adminId = `payadmin${stamp}`;

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
    await prisma.creatorBalance.create({
      data: {
        creatorId: ctx.creatorId,
        // Matured money, ready to be withdrawn.
        availableBalance: OPENING_AVAILABLE,
        // Still inside the 14-day holding, and not payable.
        pendingBalance: HELD,
        totalEarned: TOTAL_EARNED,
      },
    });
  });

  afterAll(async () => {
    await prisma.payoutRequest.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.adminId] } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: ctx.adminId } });
    await prisma.transaction.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [ctx.creatorId, ctx.adminId] } } });
    await prisma.$disconnect();
  });

  // The cases share state and run in order: this is one request moving through
  // its life, which is the thing being tested.
  it("refuses a request below the minimum without moving a shilling", async () => {
    const res = await requestPayout(MIN_PAYOUT - 1_000);
    const body = await res.json();

    expect(res.status).toBe(422);
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

    const balance = await balanceAndCheckIdentity();
    // Out of the withdrawable balance immediately — a pending request is money
    // that is spoken for, and this is what stops it being requested twice.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    // The holding is untouched: matured earnings are what a payout draws on.
    expect(balance.pendingBalance).toBe(HELD);
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
    const res = await review(paidRequestId, "APPROVED", "Verified the phone number");

    expect(res.status).toBe(200);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: paidRequestId } });
    expect(payout!.status).toBe("APPROVED");

    const balance = await balanceAndCheckIdentity();
    // Approving is a promise, not a payment: nothing moves yet, and the money
    // does not go back to being withdrawable either.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    expect(balance.pendingBalance).toBe(HELD);
  });

  it("completes an approved request", async () => {
    const res = await review(paidRequestId, "PAID", "MPESA ref 4471");

    expect(res.status).toBe(200);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: paidRequestId } });
    expect(payout!.status).toBe("PAID");
    expect(payout!.processedBy).toBe(ctx.adminId);

    const balance = await balanceAndCheckIdentity();
    // The money is gone from both buckets, and only the paid-out total grew.
    expect(balance.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    expect(balance.pendingBalance).toBe(HELD);
  });

  it("refuses a second decision on a settled request", async () => {
    const res = await review(paidRequestId, "PAID");
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

    const res = await review(requestId, "REJECTED", "Account name does not match KYC");
    expect(res.status).toBe(200);

    const refunded = await balanceAndCheckIdentity();
    // Back to exactly what was withdrawable before the rejected request, not a
    // shilling more.
    expect(refunded.availableBalance).toBe(OPENING_AVAILABLE - FIRST_REQUEST);
    const payout = await prisma.payoutRequest.findUnique({ where: { id: requestId } });
    expect(payout!.status).toBe("REJECTED");
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
  });
});
