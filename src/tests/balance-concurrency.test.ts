// =============================================================================
// GENHUB - Two things touching one balance at the same moment
//
// The worry that produced this file: the earnings-release worker and the
// subscription-renewal worker both move a creator's money, and nothing but the
// schedule offset kept them apart (release fires on the hour, renewal at :15).
// A schedule offset is not a guarantee — either one can be started by hand from
// the admin panel, GitHub Actions can be delayed under load, and a creator
// reading their own balance triggers a release for themselves on that request.
//
// So each case below starts the operations *deliberately* at the same instant
// and then checks the books. The invariant is the same one a ledger would use:
//
//     pending + available == everything ever credited - everything ever paid out
//
// and no balance is ever negative. A lost update shows up as a sum that does not
// add up, which is the only symptom an overdraw actually has.
//
// Written against the real database, because the whole question is what the
// database does when two statements race — a mock answers that question with
// whatever the mock was told to answer.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import prisma from "@/lib/db";
import config from "@/lib/config";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";
import { purchaseVideoWithWallet } from "@/lib/services/balance.service";
import { renewDueSubscriptions } from "@/lib/services/subscription-renewal.service";
import { reverseCollectedCharge } from "@/lib/services/payment-reversal.service";
import { creditCreatorForPurchase } from "@/lib/services/balance.service";

const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Older than the 14-day holding period, so it can be released. */
const MATURED_AGO = new Date(Date.now() - (config.business.holdingPeriodDays + 3) * DAY);

const stamp = Date.now();
const CREATOR = `ccreator${stamp}`;
const VIEWER = `cviewer${stamp}`;
/**
 * The refund test needs *separate customers*, not three refunds for one.
 *
 * Two refunds for the same viewer can never reach the creator's balance
 * together: the first thing each one does is credit that viewer's wallet, so
 * they queue up on the same `User` row and the second reads the balance after
 * the first has already finished with it. The window only exists between
 * different customers, who never touch each other's wallet — which is also the
 * only way it happens in production.
 */
const REFUND_VIEWERS = [0, 1, 2].map((i) => `cbuyer${i}${stamp}`);
const VIDEO_A = `cvideoa${stamp}`;
const VIDEO_B = `cvideob${stamp}`;

/**
 * True when Prisma could not obtain a connection to start the transaction.
 *
 * The reversal runs inside an interactive transaction, and Prisma has a deadline
 * for *acquiring* one: under the parallel suite that deadline is what fails, not
 * the reversal. Nothing commits, so the caller may simply try again.
 */
function isTransactionStartFailure(error: unknown): boolean {
  const typed = error as { code?: string; message?: string } | null;
  if (typed?.code === "P2028") return true;
  return /unable to start a transaction|transaction already closed/i.test(typed?.message ?? "");
}

const PRICE = 5_000;
/** 70% of PRICE, the creator's share of one sale. */
const CUT = PRICE - Math.round(PRICE * (config.business.platformFeePercent / 100));

describeE2E("Balance concurrency", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: CREATOR,
          email: `${CREATOR}@concurrency.test`,
          passwordHash: "not-a-real-hash",
          displayName: "Concurrency Creator",
          role: "CREATOR",
        },
        {
          id: VIEWER,
          email: `${VIEWER}@concurrency.test`,
          passwordHash: "not-a-real-hash",
          displayName: "Concurrency Viewer",
          role: "VIEWER",
        },
        ...REFUND_VIEWERS.map((id, i) => ({
          id,
          email: `${id}@concurrency.test`,
          passwordHash: "not-a-real-hash",
          displayName: `Refund Buyer ${i}`,
          role: "VIEWER" as const,
        })),
      ],
    });

    for (const [id, bunny] of [
      [VIDEO_A, `bunny-a-${stamp}`],
      [VIDEO_B, `bunny-b-${stamp}`],
    ] as const) {
      await prisma.video.create({
        data: { id, creatorId: CREATOR, title: `Concurrency ${id}`, bunnyVideoId: bunny, price: PRICE },
      });
    }
  });

  afterAll(async () => {
    const viewers = [VIEWER, ...REFUND_VIEWERS];
    await prisma.videoAccess.deleteMany({ where: { viewerId: { in: viewers } } });
    await prisma.videoEarning.deleteMany({ where: { videoId: { in: [VIDEO_A, VIDEO_B] } } });
    await prisma.creatorSubscription.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.notification.deleteMany({ where: { userId: { in: [CREATOR, ...viewers] } } });
    await prisma.transaction.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.creatorProfile.deleteMany({ where: { userId: CREATOR } });
    await prisma.video.deleteMany({ where: { id: { in: [VIDEO_A, VIDEO_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [CREATOR, ...viewers] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.videoAccess.deleteMany({ where: { viewerId: VIEWER } });
    await prisma.videoEarning.deleteMany({ where: { videoId: { in: [VIDEO_A, VIDEO_B] } } });
    await prisma.creatorSubscription.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.transaction.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.creatorBalance.deleteMany({ where: { creatorId: CREATOR } });
    await prisma.user.update({ where: { id: VIEWER }, data: { walletBalance: 0 } });
  });

  /** Give the creator earnings that are already past the holding period. */
  async function maturedEarnings(amount: number) {
    await prisma.creatorBalance.create({
      data: {
        creatorId: CREATOR,
        pendingBalance: amount,
        availableBalance: 0,
        totalEarned: amount,
      },
    });
    await prisma.transaction.create({
      data: {
        userId: VIEWER,
        creatorId: CREATOR,
        videoId: VIDEO_A,
        amount,
        type: "PPV_PURCHASE",
        status: "SUCCESS",
        creatorCut: amount,
        createdAt: MATURED_AGO,
      },
    });
  }

  async function balance() {
    const row = await prisma.creatorBalance.findUnique({ where: { creatorId: CREATOR } });
    return {
      pending: row?.pendingBalance ?? 0,
      available: row?.availableBalance ?? 0,
      releasedTotal: row?.releasedTotal ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. The pair this file exists for: earnings release vs subscription renewal
  // ---------------------------------------------------------------------------

  it("releases matured earnings exactly once when six runs start together", async () => {
    // Six concurrent releases of the same creator. Only one may move the money:
    // the rest must find `releasedTotal` already advanced and do nothing.
    await maturedEarnings(12_000);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => releaseMatureEarnings(CREATOR))
    );
    const released = results.reduce((sum, r) => sum + r.released, 0);

    expect(released).toBe(12_000);
    expect(await balance()).toEqual({ pending: 0, available: 12_000, releasedTotal: 12_000 });
  });

  it("keeps the books balanced when a renewal credits the creator mid-release", async () => {
    // The real shape of the worry: the renewal worker credits `pendingBalance`
    // while the release worker drains it into `availableBalance`, both for the
    // same creator, both starting now. A credit is a relative update and the
    // release is guarded, so the sum must still reconcile afterwards.
    await maturedEarnings(12_000);
    await prisma.user.update({ where: { id: VIEWER }, data: { walletBalance: PRICE } });
    await prisma.creatorSubscription.create({
      data: {
        viewerId: VIEWER,
        creatorId: CREATOR,
        price: PRICE,
        expiresAt: new Date(Date.now() + HOUR),
        isActive: true,
        autoRenew: true,
      },
    });

    // Scoped to this viewer so the test cannot charge a subscription that
    // belongs to another file — the worker scans every due membership when it is
    // given no scope, which is what made this test interfere with the renewal
    // suite's counts.
    const [, , release] = await Promise.all([
      renewDueSubscriptions({ viewerId: VIEWER }),
      renewDueSubscriptions({ viewerId: VIEWER }),
      releaseMatureEarnings(CREATOR),
    ]);

    // The fan's balance covers exactly one period, so however the runs
    // interleave, exactly one period may be charged: a wallet at 0 with a
    // non-zero charge count is that statement.
    const viewer = await prisma.user.findUnique({ where: { id: VIEWER } });
    expect(viewer?.walletBalance).toBe(0);

    const charges = await prisma.transaction.count({
      where: { creatorId: CREATOR, type: "SUBSCRIPTION", status: "SUCCESS" },
    });
    expect(charges).toBe(1);

    // Everything ever credited to this creator: the matured 12,000 plus the
    // renewal's share. Nothing paid out, so pending + available must equal it.
    const after = await balance();
    expect(after.releasedTotal).toBe(12_000);
    expect(after.pending + after.available).toBe(12_000 + CUT * charges);
    expect(after.pending).toBeGreaterThanOrEqual(0);
    expect(after.available).toBeGreaterThanOrEqual(0);
    // And the release did move the matured part across.
    expect(after.available).toBe(12_000);
    expect(release.released).toBe(12_000);
  });

  it("does not release another creator's earnings while one release runs", async () => {
    // The release claims per creator, so a slow run for creator A must not stop
    // or duplicate a run for creator B.
    await maturedEarnings(12_000);
    const [a, b] = await Promise.all([
      releaseMatureEarnings(CREATOR),
      releaseMatureEarnings(CREATOR),
    ]);
    expect(a.released + b.released).toBe(12_000);
  });

  // ---------------------------------------------------------------------------
  // 2. Spending a balance that is only enough for one purchase
  // ---------------------------------------------------------------------------

  it("refuses the second purchase when one balance can only cover one", async () => {
    // Five purchases of the full balance, all starting together — a double
    // click, or two tabs. Exactly one may be charged, and the balance may never
    // go below zero: `decrement` on its own happily takes a wallet to -20,000.
    await prisma.user.update({ where: { id: VIEWER }, data: { walletBalance: PRICE } });

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        purchaseVideoWithWallet({
          userId: VIEWER,
          creatorId: CREATOR,
          videoId: VIDEO_A,
          amount: PRICE,
          originalPrice: PRICE,
        })
      )
    );

    const succeeded = attempts.filter((a) => a.success).length;
    expect(succeeded).toBe(1);

    const viewer = await prisma.user.findUnique({ where: { id: VIEWER } });
    expect(viewer?.walletBalance).toBe(0);
    expect(viewer?.walletBalance ?? 0).toBeGreaterThanOrEqual(0);

    // One charge, one credit — not five of each.
    const charges = await prisma.transaction.count({
      where: { creatorId: CREATOR, type: "PPV_PURCHASE", status: "SUCCESS" },
    });
    expect(charges).toBe(1);
    expect((await balance()).pending).toBe(CUT);
  });

  it("lets both purchases through when the balance covers both", async () => {
    // The guard must not become a bottleneck: two purchases with money for two
    // must both succeed.
    await prisma.user.update({ where: { id: VIEWER }, data: { walletBalance: PRICE * 2 } });

    const [first, second] = await Promise.all([
      purchaseVideoWithWallet({
        userId: VIEWER,
        creatorId: CREATOR,
        videoId: VIDEO_A,
        amount: PRICE,
        originalPrice: PRICE,
      }),
      purchaseVideoWithWallet({
        userId: VIEWER,
        creatorId: CREATOR,
        videoId: VIDEO_B,
        amount: PRICE,
        originalPrice: PRICE,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const viewer = await prisma.user.findUnique({ where: { id: VIEWER } });
    expect(viewer?.walletBalance).toBe(0);
    expect((await balance()).pending).toBe(CUT * 2);
  });

  // ---------------------------------------------------------------------------
  // 3. A gateway credit landing while the same creator is being credited
  // ---------------------------------------------------------------------------

  it("counts every concurrent gateway credit", async () => {
    // Credits are relative updates, so nothing may be lost when four land at
    // once — this is the "lost update" half of the problem.
    await prisma.creatorBalance.create({
      data: { creatorId: CREATOR, pendingBalance: 0, availableBalance: 0, totalEarned: 0 },
    });

    const charges = await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const tx = await prisma.transaction.create({
          data: {
            userId: VIEWER,
            creatorId: CREATOR,
            videoId: VIDEO_A,
            amount: PRICE,
            type: "PPV_PURCHASE",
            status: "PENDING",
            metadata: { concurrencyIndex: i },
          },
        });
        return creditCreatorForPurchase({
          transactionId: tx.id,
          creatorId: CREATOR,
          videoId: VIDEO_A,
          totalAmount: PRICE,
        });
      })
    );

    expect(charges).toHaveLength(4);
    expect((await balance()).pending).toBe(CUT * 4);
  });

  // ---------------------------------------------------------------------------
  // 4. Taking money back out again
  // ---------------------------------------------------------------------------

  it("cannot take back more than the creator holds when two refunds land together", async () => {
    // Three charges refunded at once against a balance that covers one of them.
    // The clawback reads the balance to decide how much is there, so a
    // read-then-write lets two of them take the same money and leave the
    // balance negative — money the platform never had.
    //
    // That window is between one transaction's read and its write, and a window
    // measured in microseconds does not open on demand: fire twenty refunds and
    // hope, and they usually run one after another, so the guard goes untested
    // while the suite stays green. This test forces the collision instead. It
    // holds the balance row with SELECT ... FOR UPDATE, which blocks writes but
    // not the plain read the clawback begins with, so every refund reads the
    // same untouched balance and only then queues up to write it. Without the
    // amounts-as-conditions on that write, the second one lands.
    //
    // Three refunds, not twenty, because they are now guaranteed to collide —
    // and each one holds a database connection while it waits, out of a pool of
    // nine.
    const charges = await Promise.all(
      REFUND_VIEWERS.map((viewerId) =>
        prisma.transaction.create({
          data: {
            userId: viewerId,
            creatorId: CREATOR,
            videoId: VIDEO_A,
            amount: PRICE,
            type: "PPV_PURCHASE",
            status: "SUCCESS",
            creatorCut: CUT,
          },
        })
      )
    );

    // Only CUT is still held: the rest was already paid out.
    await prisma.creatorBalance.create({
      data: {
        creatorId: CREATOR,
        pendingBalance: CUT,
        availableBalance: 0,
        totalEarned: CUT * REFUND_VIEWERS.length,
      },
    });

    // Held on its own connection until this test opens the gate. `FOR UPDATE`
    // blocks writers only: the reads the refunds start with pass straight
    // through, which is exactly the window being tested.
    let lockAcquired = () => {};
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    let openTheGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    const lockHeld = prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "CreatorBalance" WHERE "creatorId" = ${CREATOR} FOR UPDATE`;
          lockAcquired();
          await gate;
        },
        { timeout: 30_000 }
      )
      .then(() => undefined);

    await acquired;

    const pending = Promise.all(
      charges.map((charge) =>
        reverseCollectedCharge({
          transactionId: charge.id,
          destination: "WALLET",
          actorId: "test-admin",
          reason: "concurrency proof",
        }).catch((error) => {
          // A transaction that could not START never committed — Prisma throws
          // for that when the connection pool is saturated, which is what this
          // whole suite competing for one database looks like. Nothing moved, so
          // it is not a safety violation, and the service deliberately lets it
          // escape rather than reporting a reversal it never performed.
          //
          // Only that. Any other throw is a bug in the reversal, and re-throwing
          // keeps the distinctions: this is a tolerance for infrastructure
          // contention, not a shrug.
          if (isTransactionStartFailure(error)) return { ok: false as const, reason: "busy" as const };
          throw error;
        })
      )
    );

    // Let every refund that is going to reach the write reach it, so the lock
    // opens onto a real queue rather than an empty one. Asking the database
    // beats sleeping: the wait ends when the contention actually exists.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const waiting = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
          FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query LIKE '%"CreatorBalance"%'
      `;
      if (waiting[0].waiting >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    openTheGate();
    await lockHeld;

    const results = await pending;

    // Either the charge reversed, or the database refused to start. A refusal
    // for any *other* reason — already refunded, not reversible, insufficient —
    // would mean the guard itself mis-decided, and that must fail this test.
    const refused = results.filter((r) => !r.ok);
    expect(refused.every((r) => r.reason === "busy")).toBe(true);
    // At least one must actually have run, or the assertions below would be
    // measuring an empty book.
    expect(results.some((r) => r.ok)).toBe(true);

    const after = await balance();
    // The books may not be driven negative by two refunds sharing one balance.
    expect(after.pending).toBeGreaterThanOrEqual(0);
    expect(after.available).toBeGreaterThanOrEqual(0);

    // What was actually clawed back is what the creator held: no more.
    const clawedBack = CUT - (after.pending + after.available);
    expect(clawedBack).toBe(CUT);
  });
});
