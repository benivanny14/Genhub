// =============================================================================
// GENHUB - Subscription auto-renewal
//
// Real database. Locks in the behaviour of renewDueSubscriptions():
//   1. wallet covers the price  -> renewed instantly, 70/30 split recorded, the
//      period is extended from the OLD expiry (no lost days)
//   2. wallet short + phone on file -> a HarakaPay USSD push is created
//   3. nothing to pay with -> the reason is recorded and the fan is told
//   4. one attempt per retry gap, never a second push while one is live
//   5. out of retries and lapsed -> membership closed, counter resynced
//
// The gateway module is replaced with a spy so nothing is ever charged.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  viewerId: "",
  creatorId: "",
  idleViewerId: "",
  amount: 5_000,
}));

// Force the production-like configuration: key present, sandbox off. Combined
// with the harakaCollect spy below this exercises the real code path without
// any network call.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, any> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      nodeEnv: "test",
      appUrl: "https://genhub.test",
      harakaPay: {
        ...actual.default.harakaPay,
        apiKey: "test-key",
        sandbox: false,
        webhookToken: "tok",
      },
    },
  };
});

vi.mock("@/lib/payments/harakapay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/harakapay")>();
  return {
    ...actual,
    harakaCollect: vi.fn(async () => ({
      success: true,
      order_id: "HP_TEST_RENEWAL",
      message: "USSD push sent to phone",
    })),
  };
});

import prisma from "@/lib/db";
import { harakaCollect } from "@/lib/payments/harakapay";
import {
  renewDueSubscriptions,
  MAX_RENEW_ATTEMPTS,
  RETRY_GAP_MS,
  STALE_WINDOW_MS,
} from "@/lib/services/subscription-renewal.service";
import { nextRenewalDate } from "@/lib/services/subscription.service";

const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;
const PHONE = "0712345678";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeE2E("Subscription auto-renewal", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    ctx.creatorId = `rcreator${stamp}`;
    ctx.viewerId = `rviewer${stamp}`;
    ctx.idleViewerId = `ridle${stamp}`;

    for (const [id, role, name] of [
      [ctx.creatorId, "CREATOR", "Renewal Creator"],
      [ctx.viewerId, "VIEWER", "Renewal Fan"],
      [ctx.idleViewerId, "VIEWER", "Idle Fan"],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@renewal.test`,
          passwordHash: "not-a-real-hash",
          displayName: name,
          role,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.creatorSubscription.deleteMany({
      where: { creatorId: ctx.creatorId },
    });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorProfile.deleteMany({ where: { userId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.viewerId, ctx.idleViewerId] } },
    });
    await prisma.transaction.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ctx.creatorId, ctx.viewerId, ctx.idleViewerId] } },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(harakaCollect).mockClear();
    await prisma.creatorSubscription.deleteMany({
      where: { creatorId: ctx.creatorId },
    });
    await prisma.transaction.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: ctx.creatorId } });
    await prisma.creatorProfile.deleteMany({ where: { userId: ctx.creatorId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [ctx.creatorId, ctx.viewerId, ctx.idleViewerId] } },
    });
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: 0 },
    });
  });

  /** A membership that expires in 1 hour — inside the 24h renewal window. */
  async function dueSubscription(overrides: Record<string, unknown> = {}) {
    const expiresAt = new Date(Date.now() + HOUR);
    return prisma.creatorSubscription.create({
      data: {
        viewerId: ctx.viewerId,
        creatorId: ctx.creatorId,
        price: ctx.amount,
        expiresAt,
        isActive: true,
        autoRenew: true,
        ...overrides,
      },
    });
  }

  // ---------------------------------------------------------------- 1. wallet
  it("renews from the wallet, splits 70/30 and extends from the old expiry", async () => {
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: ctx.amount * 3 },
    });
    const before = await dueSubscription();

    const result = await renewDueSubscriptions();

    expect(result.renewedFromWallet).toBe(1);
    expect(result.pushedToPhone).toBe(0);
    expect(result.failed).toBe(0);

    // Wallet debited exactly once
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(ctx.amount * 3 - ctx.amount);

    // 70/30 split, held for the 14-day window
    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, creatorId: ctx.creatorId, type: "SUBSCRIPTION" },
      orderBy: { createdAt: "desc" },
    });
    expect(tx?.status).toBe("SUCCESS");
    expect(tx?.gateway).toBeNull();
    expect(tx?.platformFee).toBe(1_500);
    expect(tx?.creatorCut).toBe(3_500);

    const balance = await prisma.creatorBalance.findUnique({
      where: { creatorId: ctx.creatorId },
    });
    expect(balance?.pendingBalance).toBe(3_500);

    // Extended from the OLD expiry, not from now
    const sub = await prisma.creatorSubscription.findUnique({
      where: { id: before.id },
    });
    const expected = new Date(before.expiresAt);
    expected.setMonth(expected.getMonth() + 1);
    expect(sub!.expiresAt.toISOString()).toBe(expected.toISOString());
    expect(sub!.renewAttempts).toBe(0);
    expect(sub!.lastRenewedAt).not.toBeNull();

    // Both sides are told
    const fanNote = await prisma.notification.findFirst({
      where: { userId: ctx.viewerId, title: "Membership renewed ✅" },
    });
    expect(fanNote).not.toBeNull();
    const creatorNote = await prisma.notification.findFirst({
      where: { userId: ctx.creatorId, title: "Membership renewed ⭐" },
    });
    expect(creatorNote).not.toBeNull();
  });

  // ------------------------------------------------------------ 2. USSD push
  it("sends a USSD push when the wallet is short but a phone number is on file", async () => {
    await dueSubscription({ renewPhone: PHONE });

    const result = await renewDueSubscriptions();

    expect(result.pushedToPhone).toBe(1);
    expect(result.renewedFromWallet).toBe(0);

    expect(harakaCollect).toHaveBeenCalledTimes(1);
    const call = vi.mocked(harakaCollect).mock.calls[0][0];
    expect(call.phone).toBe(PHONE);
    expect(call.amount).toBe(ctx.amount);
    expect(call.webhookUrl).toContain("/api/webhooks/harakapay");
    expect(call.webhookUrl).toContain("t=tok");

    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, creatorId: ctx.creatorId, type: "SUBSCRIPTION" },
    });
    expect(tx?.status).toBe("PENDING");
    expect(tx?.gateway).toBe("HARAKAPAY");
    expect(tx?.providerRef).toBe("HP_TEST_RENEWAL");
    expect((tx?.metadata as { renewal?: boolean } | null)?.renewal).toBe(true);

    const sub = await prisma.creatorSubscription.findFirst({
      where: { creatorId: ctx.creatorId },
    });
    expect(sub!.renewAttempts).toBe(1);
    expect(sub!.renewPhone).toBe(PHONE);

    const note = await prisma.notification.findFirst({
      where: { userId: ctx.viewerId, title: "Approve your renewal 📱" },
    });
    expect(note).not.toBeNull();
    expect(note!.message).toContain(PHONE);
  });

  // ------------------------------------------------------- 3. nothing to pay
  it("records the reason and tells the fan when there is no wallet balance and no phone", async () => {
    await dueSubscription();

    const result = await renewDueSubscriptions();

    expect(result.failed).toBe(1);
    expect(harakaCollect).not.toHaveBeenCalled();

    const sub = await prisma.creatorSubscription.findFirst({
      where: { creatorId: ctx.creatorId },
    });
    expect(sub!.renewAttempts).toBe(1);
    expect(sub!.lastRenewError).toContain("no phone number");

    const note = await prisma.notification.findFirst({
      where: { userId: ctx.viewerId, title: "Renewal needs your attention" },
    });
    expect(note).not.toBeNull();

    // No money moved anywhere
    const txs = await prisma.transaction.count({ where: { creatorId: ctx.creatorId } });
    expect(txs).toBe(0);
  });

  // ----------------------------------------------------------- 4. retry gap
  it("waits for the retry gap before trying again", async () => {
    await dueSubscription({
      renewPhone: PHONE,
      renewAttempts: 1,
      lastRenewAttemptAt: new Date(Date.now() - RETRY_GAP_MS / 2),
    });

    const result = await renewDueSubscriptions();

    expect(result.skipped).toBe(1);
    expect(harakaCollect).not.toHaveBeenCalled();
  });

  it("does not stack a second push while the first is still awaiting approval", async () => {
    await dueSubscription({ renewPhone: PHONE, lastRenewAttemptAt: null });
    await prisma.transaction.create({
      data: {
        userId: ctx.viewerId,
        creatorId: ctx.creatorId,
        amount: ctx.amount,
        type: "SUBSCRIPTION",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "HP_STILL_WAITING",
        metadata: { renewal: true, phone: PHONE },
      },
    });

    const result = await renewDueSubscriptions();

    expect(result.awaitingApproval).toBe(1);
    expect(result.pushedToPhone).toBe(0);
    expect(harakaCollect).not.toHaveBeenCalled();
    const count = await prisma.transaction.count({ where: { creatorId: ctx.creatorId } });
    expect(count).toBe(1);
  });

  it("blocks a new charge even when the pending checkout is old (no double grant)", async () => {
    // A late settlement is honoured by processPaymentWebhook, so starting a
    // second charge here would extend the membership twice for one payment.
    await dueSubscription({ renewPhone: PHONE });
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: ctx.amount * 3 },
    });
    const stale = await prisma.transaction.create({
      data: {
        userId: ctx.viewerId,
        creatorId: ctx.creatorId,
        amount: ctx.amount,
        type: "SUBSCRIPTION",
        status: "PENDING",
        gateway: "HARAKAPAY",
        providerRef: "HP_ABANDONED",
        metadata: { renewal: true, phone: PHONE },
      },
    });
    // Backdate it past any grace period
    await prisma.transaction.update({
      where: { id: stale.id },
      data: { createdAt: new Date(Date.now() - 6 * HOUR) },
    });

    const result = await renewDueSubscriptions();

    expect(result.awaitingApproval).toBe(1);
    expect(result.renewedFromWallet).toBe(0);
    // Neither the wallet nor the gateway was touched
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(ctx.amount * 3);
    expect(harakaCollect).not.toHaveBeenCalled();
  });

  it("stops retrying once the attempt budget is spent, even inside the paid period", async () => {
    await dueSubscription({
      renewPhone: PHONE,
      renewAttempts: MAX_RENEW_ATTEMPTS,
      lastRenewAttemptAt: new Date(Date.now() - 2 * DAY),
    });
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: ctx.amount * 3 },
    });

    const result = await renewDueSubscriptions();

    expect(result.skipped).toBe(1);
    expect(harakaCollect).not.toHaveBeenCalled();
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(ctx.amount * 3);
  });

  it("never charges a membership that lapsed outside the stale window", async () => {
    const sub = await dueSubscription({
      expiresAt: new Date(Date.now() - STALE_WINDOW_MS - DAY),
      renewPhone: PHONE,
    });
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: ctx.amount * 3 },
    });

    const result = await renewDueSubscriptions();

    expect(result.failed).toBe(1);
    expect(harakaCollect).not.toHaveBeenCalled();
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(ctx.amount * 3);
    const after = await prisma.creatorSubscription.findUnique({ where: { id: sub.id } });
    expect(after!.isActive).toBe(false);
    expect(after!.autoRenew).toBe(false);
  });

  it("advances the attempt counter when the gateway rejects a push", async () => {
    await dueSubscription({ renewPhone: PHONE, renewAttempts: 2 });
    vi.mocked(harakaCollect).mockResolvedValueOnce({
      success: false,
      error: "insufficient balance",
    });

    const result = await renewDueSubscriptions();

    expect(result.failed).toBe(1);
    const sub = await prisma.creatorSubscription.findFirst({
      where: { creatorId: ctx.creatorId },
    });
    // 2 -> 3, not reset to 1: a rejected push must burn an attempt
    expect(sub!.renewAttempts).toBe(3);
    expect(sub!.lastRenewError).toBe("insufficient balance");
    const tx = await prisma.transaction.findFirst({
      where: { userId: ctx.viewerId, creatorId: ctx.creatorId },
    });
    expect(tx?.status).toBe("FAILED");
  });

  // ---------------------------------------------------------- 5. not due yet
  it("ignores memberships that are not inside the renewal window", async () => {
    await dueSubscription({ expiresAt: new Date(Date.now() + 10 * DAY) });

    const result = await renewDueSubscriptions();

    expect(result.considered).toBe(0);
    expect(harakaCollect).not.toHaveBeenCalled();
  });

  it("ignores memberships whose automatic renewal is switched off", async () => {
    await dueSubscription({ autoRenew: false });
    await prisma.user.update({
      where: { id: ctx.viewerId },
      data: { walletBalance: ctx.amount * 3 },
    });

    const result = await renewDueSubscriptions();

    expect(result.considered).toBe(0);
    const viewer = await prisma.user.findUnique({
      where: { id: ctx.viewerId },
      select: { walletBalance: true },
    });
    expect(viewer!.walletBalance).toBe(ctx.amount * 3);
  });

  // ------------------------------------------------------------- 6. lapse
  it("lapses a membership that is out of retries and resyncs the subscriber count", async () => {
    const sub = await dueSubscription({
      expiresAt: new Date(Date.now() - HOUR),
      renewAttempts: MAX_RENEW_ATTEMPTS,
      lastRenewAttemptAt: new Date(Date.now() - DAY),
    });
    // A healthy membership for the same creator must keep counting
    await prisma.creatorSubscription.create({
      data: {
        viewerId: ctx.idleViewerId,
        creatorId: ctx.creatorId,
        price: ctx.amount,
        expiresAt: new Date(Date.now() + 20 * DAY),
        isActive: true,
        autoRenew: true,
      },
    });
    await prisma.creatorProfile.create({
      data: { userId: ctx.creatorId, totalSubscribers: 99 },
    });

    const result = await renewDueSubscriptions();

    expect(result.failed).toBe(1);
    const lapsed = await prisma.creatorSubscription.findUnique({ where: { id: sub.id } });
    expect(lapsed!.isActive).toBe(false);
    expect(lapsed!.autoRenew).toBe(false);

    const profile = await prisma.creatorProfile.findUnique({
      where: { userId: ctx.creatorId },
    });
    expect(profile!.totalSubscribers).toBe(1);
  });

  // ------------------------------------------------------- 7. expiry maths
  it("extends from the current expiry while a membership is still active", () => {
    const future = new Date(Date.now() + 10 * DAY);
    const extended = nextRenewalDate(future);
    const expected = new Date(future);
    expected.setMonth(expected.getMonth() + 1);
    expect(extended.toISOString()).toBe(expected.toISOString());
  });

  it("starts a fresh period today once the membership has lapsed", () => {
    const past = new Date(Date.now() - 30 * DAY);
    const renewed = nextRenewalDate(past);
    expect(renewed.getTime()).toBeGreaterThan(Date.now());
    expect(renewed.getTime()).toBeLessThan(Date.now() + 32 * DAY);
  });
});
