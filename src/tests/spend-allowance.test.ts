// =============================================================================
// GENHUB - The allowance the wallet shows
//
// `spendAllowance` is the read-only face of the daily cap: it reports where an
// account stands and never refuses anything, so the wallet page can show the
// number before a charge is declined instead of after. The two ways it can be
// wrong both matter — a wrong `remaining` either hides room the customer has or
// promises room the next charge will be refused for — so the arithmetic and the
// "cap is off" branch are pinned here.
//
// Prisma and config are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  config: { business: { dailySpendCap: 500_000 } },
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: { aggregate: (...a: unknown[]) => mocks.aggregate(...a) },
  },
}));

// The service reads the cap at call time, so a test can switch it off here.
vi.mock("@/lib/config", () => ({ default: mocks.config }));

import { spendAllowance } from "@/lib/services/spend-cap.service";

const USER = "user-1";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

const spentSoFar = (amount: number | null) =>
  mocks.aggregate.mockResolvedValue({ _sum: { amount } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.business.dailySpendCap = 500_000;
  spentSoFar(0);
});

describe("the allowance the wallet shows", () => {
  it("reports the cap, what is spent and what is left", async () => {
    spentSoFar(120_000);

    await expect(spendAllowance(USER, NOW)).resolves.toEqual({
      cap: 500_000,
      spent: 120_000,
      remaining: 380_000,
    });
  });

  it("treats an empty ledger as a full allowance", async () => {
    spentSoFar(null);

    await expect(spendAllowance(USER, NOW)).resolves.toEqual({
      cap: 500_000,
      spent: 0,
      remaining: 500_000,
    });
  });

  it("floors a fully spent window at zero rather than going negative", async () => {
    // A cap cannot be spent below nothing, and a negative "remaining" would
    // render as a nonsense figure on the wallet page.
    spentSoFar(650_000);

    const allowance = await spendAllowance(USER, NOW);

    expect(allowance).toEqual({ cap: 500_000, spent: 650_000, remaining: 0 });
  });

  it("answers null when the cap is switched off, and reads nothing", async () => {
    mocks.config.business.dailySpendCap = 0;

    await expect(spendAllowance(USER, NOW)).resolves.toBeNull();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("reads the same rolling window the cap enforces, for this account", async () => {
    await spendAllowance(USER, NOW);

    const where = mocks.aggregate.mock.calls[0][0].where;
    expect(where.userId).toBe(USER);
    expect(where.status).toBe("SUCCESS");
    expect(where.createdAt.gte).toEqual(new Date(NOW - 24 * 60 * 60 * 1000));
  });
});
