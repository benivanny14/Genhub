// =============================================================================
// GENHUB - GET /api/payments/health: the float block
//
// The admin Overview card reads this block to draw the HarakaPay float widget,
// so the block is a contract, not a convenience. Three of its fields were the
// easy thing to get wrong:
//
//   1. `read` and a `null` float. A gateway that will not answer, or one that
//      answers without a `float_balance`, is NOT reporting an empty float — and
//      the card has to be able to tell "0 TZS" from "we could not ask".
//   2. `level`, judged against the operator's own floor, so the card and the
//      alert service cannot disagree about where the line is.
//   3. `alertPending`, which is whether this episode has already been announced
//      — the inverse of the alarm being armed.
//
// Auth, Prisma and the gateway are mocked; no database, no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** What the gateway answers with, or an Error to throw. */
  balance: { success: true, wallet_balance: 0, float_balance: 0 } as
    | { success: boolean; wallet_balance?: number; float_balance?: number }
    | Error,
  /** Whether an alert for this episode is already in somebody's bell. */
  alertPending: false,
}));

vi.mock("@/lib/auth", () => ({
  requireRole: async () => ({ userId: "admin-1", role: "ADMIN" }),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    appUrlSource: "NEXT_PUBLIC_APP_URL",
    nodeEnv: "test",
    harakaPay: {
      sandbox: false,
      apiKey: "key",
      baseUrl: "https://harakapay.net",
      webhookToken: "token",
      floatFloorTzs: 10_000,
    },
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: {
      count: async () => 0,
      findFirst: async () => null,
    },
    notification: {
      findFirst: async () => (state.alertPending ? { id: "n1" } : null),
    },
  },
}));

vi.mock("@/lib/payments/harakapay", () => ({
  harakaBalance: async () => {
    if (state.balance instanceof Error) throw state.balance;
    return state.balance;
  },
  harakaErrorReason: () => "gateway unreachable",
  harakaGatewayState: () => ({ open: false, openUntil: 0, failures: 0, skipped: 0 }),
  harakaBreakerNotice: () => null,
}));

import { GET } from "@/app/api/payments/health/route";

/** The `float` block as the admin card reads it. */
async function floatOf() {
  const body = await (await GET()).json();
  return body.data.float as {
    read: boolean;
    floatTzs: number | null;
    walletTzs: number | null;
    floorTzs: number;
    level: "ok" | "low" | "empty" | null;
    alertPending: boolean;
  };
}

beforeEach(() => {
  state.balance = { success: true, wallet_balance: 0, float_balance: 0 };
  state.alertPending = false;
});

describe("GET /api/payments/health — float", () => {
  it("reports a funded float as healthy, against the configured floor", async () => {
    state.balance = { success: true, wallet_balance: 500, float_balance: 25_000 };

    const float = await floatOf();

    expect(float.read).toBe(true);
    expect(float.floatTzs).toBe(25_000);
    expect(float.walletTzs).toBe(500);
    expect(float.floorTzs).toBe(10_000);
    expect(float.level).toBe("ok");
  });

  it("calls a float under the floor low, not empty", async () => {
    state.balance = { success: true, wallet_balance: 0, float_balance: 4_000 };

    const float = await floatOf();

    // A warning to top up, which is a different state from the one payments
    // stop arriving in.
    expect(float.level).toBe("low");
    expect(float.read).toBe(true);
  });

  it("calls an empty float empty — and still readable", async () => {
    const float = await floatOf();

    expect(float.read).toBe(true);
    expect(float.floatTzs).toBe(0);
    expect(float.level).toBe("empty");
  });

  it("does not read a missing float_balance as zero", async () => {
    // The distinction the whole widget turns on: "0 TZS" is a fact, "we could
    // not ask" is not, and a card that shows the second as the first is lying.
    state.balance = { success: true, wallet_balance: 500 };

    const float = await floatOf();

    expect(float.read).toBe(false);
    expect(float.floatTzs).toBeNull();
    expect(float.level).toBeNull();
  });

  it("does not read a gateway that throws as empty", async () => {
    state.balance = new Error("HarakaPay /api/v1/balance error 503");

    const float = await floatOf();

    expect(float.read).toBe(false);
    expect(float.floatTzs).toBeNull();
    expect(float.level).toBeNull();
  });

  it("says whether this episode has already been announced", async () => {
    expect((await floatOf()).alertPending).toBe(false);

    state.alertPending = true;
    expect((await floatOf()).alertPending).toBe(true);
  });
});
