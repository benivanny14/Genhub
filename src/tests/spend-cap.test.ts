// =============================================================================
// GENHUB - The daily spend cap
//
// The cap answers one question — has this account already spent its budget for
// the last 24 hours — and the two ways it can be wrong are both expensive: too
// loose and a drained wallet is not stopped, too tight and a paying customer is
// refused. So the window, the direction of the money and the arithmetic are all
// pinned here.
//
// Prisma is mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ aggregate: vi.fn() }));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: { aggregate: (...a: unknown[]) => mocks.aggregate(...a) },
  },
}));

import {
  checkSpendCap,
  dailySpend,
  SPEND_TYPES,
  SPEND_WINDOW_MS,
} from "@/lib/services/spend-cap.service";

const USER = "user-1";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

/** The aggregate Prisma would return for a given 24-hour total. */
const spentSoFar = (amount: number | null) =>
  mocks.aggregate.mockResolvedValue({ _sum: { amount } });

beforeEach(() => {
  vi.clearAllMocks();
  spentSoFar(0);
});

describe("what the window counts", () => {
  it("counts only SUCCESS rows and only money going OUT of the wallet", async () => {
    await dailySpend(USER, NOW);

    const where = mocks.aggregate.mock.calls[0][0].where;
    expect(where.userId).toBe(USER);
    expect(where.status).toBe("SUCCESS");
    // A top-up or a referral bonus must never count toward a spend cap, or
    // adding funds would eat the budget the cap is protecting.
    expect(where.type.in).toEqual([...SPEND_TYPES]);
    expect(where.type.in).not.toContain("WALLET_TOPUP");
    expect(where.type.in).not.toContain("REFERRAL_BONUS");
  });

  it("is a rolling 24 hours, not a calendar day", async () => {
    await dailySpend(USER, NOW);

    const where = mocks.aggregate.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date(NOW - SPEND_WINDOW_MS));
    expect(SPEND_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("treats an empty ledger as zero, not as missing", async () => {
    spentSoFar(null);
    await expect(dailySpend(USER, NOW)).resolves.toBe(0);
  });
});

describe("the arithmetic", () => {
  it("allows a charge that fits under the cap", async () => {
    spentSoFar(400_000);

    const state = await checkSpendCap(USER, 50_000, NOW);

    expect(state.allowed).toBe(true);
    expect(state.spent).toBe(400_000);
    expect(state.remaining).toBe(100_000);
    expect(state.overBy).toBe(0);
  });

  it("allows a charge that lands exactly on the cap", async () => {
    spentSoFar(450_000);

    const state = await checkSpendCap(USER, 50_000, NOW);

    expect(state.allowed).toBe(true);
    expect(state.remaining).toBe(50_000);
  });

  it("refuses a charge that goes past the cap, and says by how much", async () => {
    spentSoFar(480_000);

    const state = await checkSpendCap(USER, 50_000, NOW);

    expect(state.allowed).toBe(false);
    expect(state.remaining).toBe(20_000);
    expect(state.overBy).toBe(30_000);
  });

  it("reports the default cap it is enforcing", async () => {
    const state = await checkSpendCap(USER, 1_000, NOW);
    expect(state.cap).toBe(500_000);
  });
});
