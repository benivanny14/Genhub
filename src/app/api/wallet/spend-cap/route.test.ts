// =============================================================================
// GENHUB - GET /api/wallet/spend-cap
//
// The wallet page draws the daily-spend panel straight from this payload, so
// two failures are silent: a missing `remaining` renders as a blank bar, and a
// cap that is switched off must come back as null so the panel hides rather than
// promising an allowance nothing enforces. The route must also be tied to the
// signed-in account — a spend figure that leaked across users would be a
// privacy bug, not a rounding error.
//
// Auth and the spend-cap service are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  spendAllowance: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("@/lib/services/spend-cap.service", () => ({
  spendAllowance: (...a: unknown[]) => mocks.spendAllowance(...a),
}));

import { GET } from "./route";
import { AuthError } from "@/lib/auth";

const USER = "user-1";

function get() {
  return GET(new NextRequest("https://app.test/api/wallet/spend-cap"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: USER, role: "VIEWER" });
  mocks.spendAllowance.mockResolvedValue({
    cap: 500_000,
    spent: 120_000,
    remaining: 380_000,
  });
});

describe("GET /api/wallet/spend-cap", () => {
  it("hands the wallet page the allowance for the signed-in account", async () => {
    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.spendAllowance).toHaveBeenCalledWith(USER);
    expect(body.data).toEqual({ cap: 500_000, spent: 120_000, remaining: 380_000 });
  });

  it("returns null when the cap is switched off, so the panel can hide", async () => {
    mocks.spendAllowance.mockResolvedValue(null);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
  });

  it("refuses a signed-out caller", async () => {
    mocks.requireAuth.mockRejectedValue(new AuthError("Authentication required"));

    const res = await get();

    expect(res.status).toBe(401);
    expect(mocks.spendAllowance).not.toHaveBeenCalled();
  });
});
