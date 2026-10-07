// =============================================================================
// GENHUB - POST /api/creator/payouts
//
// The creator asking for their money, and the one thing the route does besides
// take the request: tell the admins.
//
// Why that is pinned here rather than left to the queue:
//
//   1. A request nobody is told about waits until somebody happens to open the
//      tab. The crossing alert (payout-threshold.service.ts) cannot cover it —
//      it fires when a balance passes Genhub's floor, which can be days before
//      the creator asks, and NEVER for an account an admin has allowed to
//      withdraw below the floor. Those are exactly the small hand payments that
//      otherwise sit in silence.
//   2. The alert has to name the creator and where the money is going, since
//      that is the part an admin cannot read off the queue without opening a row.
//   3. It must not fire for a request that was REFUSED, and it must not be able
//      to fail one that was accepted.
//
// Prisma, auth, the payout service and the notifier are mocked; no database. The
// money itself is asserted against a real database in src/tests/payout-cycle.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  payoutFindMany: vi.fn(),
  requestPayout: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: (...a: unknown[]) => mocks.userFindUnique(...a) },
    payoutRequest: { findMany: (...a: unknown[]) => mocks.payoutFindMany(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: async () => ({ userId: "creator-1", role: "CREATOR" }),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/services/payout.service", () => ({
  requestPayout: (...a: unknown[]) => mocks.requestPayout(...a),
}));

vi.mock("@/lib/services/notify.service", () => ({
  notifyAdmins: (...a: unknown[]) => mocks.notifyAdmins(...a),
}));

import { POST } from "@/app/api/creator/payouts/route";

function request(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/creator/payouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** A verified, unfrozen creator whose withdrawals are not paused. */
function verifiedCreator(over: Record<string, unknown> = {}) {
  return {
    kycStatus: "APPROVED",
    payoutFrozenUntil: null,
    payoutFrozenReason: null,
    payoutMinimumWaived: false,
    displayName: "Amina Salehe",
    email: "amina@genhub.test",
    ...over,
  };
}

const WITHDRAWAL = { amount: 100_000, paymentMethod: "MPESA", accountDetails: "0682642219" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue(verifiedCreator());
  mocks.requestPayout.mockResolvedValue({
    ok: true,
    payoutId: "payout-1",
    amount: 100_000,
    availableBalance: 40_000,
  });
  mocks.notifyAdmins.mockResolvedValue(1);
});

describe("POST /api/creator/payouts — the admins hear about it", () => {
  it("tells the admins who asked, how much, and where it is going", async () => {
    const res = await request(WITHDRAWAL);

    expect(res.status).toBe(201);
    expect(mocks.notifyAdmins).toHaveBeenCalledTimes(1);
    const alert = mocks.notifyAdmins.mock.calls[0][0];
    expect(alert.title).toContain("Withdrawal");
    // The name, not a cuid: an alert that says "cms4k2…" is one an admin has to
    // go and look up.
    expect(alert.message).toContain("Amina Salehe");
    expect(alert.message).toContain("TZS 100,000");
    // The destination is the one fact the queue row hides.
    expect(alert.message).toContain("M-Pesa · 0682642219");
    expect(alert.link).toBe("/admin");
    // One alert per request, keyed so a phone shows the latest instead of a
    // pile of them.
    expect(alert.pushTag).toBe("payout-request");
  });

  it("names a bank transfer by its bank", async () => {
    await request({
      amount: 30_000,
      paymentMethod: "BANK_TRANSFER",
      accountDetails: "0123456789000",
      bankName: "CRDB",
    });

    expect(mocks.notifyAdmins.mock.calls[0][0].message).toContain("Bank transfer · CRDB");
  });

  it("falls back to the email rather than announcing nobody", async () => {
    // A creator can have no display name. The alert still has to say who.
    mocks.userFindUnique.mockResolvedValue(verifiedCreator({ displayName: null }));

    await request(WITHDRAWAL);

    expect(mocks.notifyAdmins.mock.calls[0][0].message).toContain("amina@genhub.test");
  });

  it("stays quiet when the request was refused", async () => {
    // Nothing happened, so there is nothing to act on: an alert per refused
    // attempt would train admins to ignore the ones that matter.
    mocks.requestPayout.mockResolvedValue({
      ok: false,
      reason: "AMOUNT_BELOW_MINIMUM",
      availableBalance: 25_000,
      minimum: 30_000,
    });

    const res = await request({ ...WITHDRAWAL, amount: 20_000 });

    expect(res.status).toBe(400);
    expect(mocks.notifyAdmins).not.toHaveBeenCalled();
  });

  it("keeps the creator's withdrawal accepted even if the alert breaks", async () => {
    // The money is already earmarked by the time the alert is sent. A notifier
    // failure that surfaced as a 500 would tell the creator their request failed
    // while their balance had already dropped.
    mocks.notifyAdmins.mockRejectedValue(new Error("no admins, db down, anything"));

    const res = await request(WITHDRAWAL);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("PENDING");
  });

  it("still refuses a creator whose identity is not approved, before any of this", async () => {
    mocks.userFindUnique.mockResolvedValue(verifiedCreator({ kycStatus: "PENDING" }));

    const res = await request(WITHDRAWAL);

    expect(res.status).toBe(403);
    expect(mocks.requestPayout).not.toHaveBeenCalled();
    expect(mocks.notifyAdmins).not.toHaveBeenCalled();
  });
});
