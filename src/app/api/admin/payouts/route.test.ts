// =============================================================================
// GENHUB - /api/admin/payouts
//
// The queue an admin clears withdrawals from. Two things are pinned here, both
// of which were broken in ways that looked like success:
//
//   1. THE QUEUE HAS TO HOLD EVERYTHING STILL OPEN. It asked for `PENDING` only,
//      so the moment a request was approved it vanished from the one screen that
//      could mark it paid. Nothing errored; the money simply stayed earmarked
//      forever. The status list is now comma-separated, and — just as important
//      — unknown values are dropped instead of passed to Prisma, because the old
//      `status as any` handed a typo straight to the enum and answered a list
//      request with a 500.
//
//   2. WHICH DECISIONS ARE STILL AVAILABLE. Approving says "we will send this";
//      marking paid says "we sent it". So PAID must be reachable from APPROVED,
//      but a settled request must refuse every further action — that refusal is
//      what stops a rejection being refunded twice.
//
// Prisma and auth are mocked; no database. The money those transitions move is
// asserted against a real database in src/tests/payout-cycle.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  balanceUpdate: vi.fn(),
  transaction: vi.fn(),
  notification: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    payoutRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      count: (...a: unknown[]) => mocks.count(...a),
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
    creatorBalance: { update: (...a: unknown[]) => mocks.balanceUpdate(...a) },
    notification: { create: (...a: unknown[]) => mocks.notification(...a) },
    // The rejection branch wraps its two writes in a transaction; the callback
    // is run against the same mock, which is what the balance assertion reads.
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.transaction();
      return fn({
        payoutRequest: { update: (...a: unknown[]) => mocks.update(...a) },
        creatorBalance: { update: (...a: unknown[]) => mocks.balanceUpdate(...a) },
      });
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: async () => ({ userId: "admin-1", role: "ADMIN" }),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/services/audit.service", () => ({
  AUDIT_ACTIONS: { payoutApprove: "payout.approve", payoutPaid: "payout.paid", payoutReject: "payout.reject" },
  recordAudit: (...a: unknown[]) => mocks.audit(...a),
}));

import { GET, POST } from "@/app/api/admin/payouts/route";

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/admin/payouts${query}`));
}

function review(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/admin/payouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** The `where` the route handed to Prisma, on the list query. */
function whereOf(): { status: { in: string[] } } {
  return mocks.findMany.mock.calls[0][0].where;
}

describe("GET /api/admin/payouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
  });

  it("defaults to the pending queue", async () => {
    const res = await get("");

    expect(res.status).toBe(200);
    expect(whereOf()).toEqual({ status: { in: ["PENDING"] } });
  });

  it("can list both open statuses at once", async () => {
    // What the admin screen asks for. If this stops working, approved requests
    // go back to being invisible and unfinishable.
    await get("?status=PENDING,APPROVED");

    expect(whereOf().status.in).toEqual(["PENDING", "APPROVED"]);
  });

  it("keeps a settled request out of the open queue", async () => {
    await get("?status=APPROVED");

    expect(whereOf().status.in).not.toContain("PAID");
    expect(whereOf().status.in).not.toContain("REJECTED");
  });

  it("drops an unknown status instead of asking the database for it", async () => {
    // `as any` used to put this straight into the enum, where it came back as a
    // 500 rather than a list.
    const res = await get("?status=PAIDISH");

    expect(res.status).toBe(200);
    expect(whereOf().status.in).toEqual(["PENDING"]);
  });

  it("keeps the statuses it does recognise, in any case, and only those", async () => {
    await get("?status=paidish,approved");

    expect(whereOf().status.in).toEqual(["APPROVED"]);
  });

  it("counts the same set it lists", async () => {
    await get("?status=PENDING,APPROVED");

    expect(mocks.count.mock.calls[0][0].where).toEqual(whereOf());
  });
});

describe("POST /api/admin/payouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.balanceUpdate.mockResolvedValue({});
    mocks.notification.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
  });

  function existing(status: string) {
    mocks.findUnique.mockResolvedValue({
      id: "payout-1",
      creatorId: "creator-1",
      amount: 100_000,
      paymentMethod: "MPESA",
      status,
      creator: { displayName: "Ivanny", email: "ivanny@test" },
    });
  }

  it("completes an approved request, which is the whole point of approving", async () => {
    existing("APPROVED");

    const res = await review({ payoutId: "payout-1", action: "PAID" });

    expect(res.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("PAID");
    // Sending money does not put any back: only a rejection credits the balance.
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][0].action).toBe("payout.paid");
  });

  it("returns the money and nothing else when a request is rejected", async () => {
    existing("PENDING");

    const res = await review({ payoutId: "payout-1", action: "REJECTED" });

    expect(res.status).toBe(200);
    expect(mocks.balanceUpdate.mock.calls[0][0]).toMatchObject({
      where: { creatorId: "creator-1" },
      data: { availableBalance: { increment: 100_000 } },
    });
  });

  it("refuses a second decision on a settled request", async () => {
    existing("PAID");

    const res = await review({ payoutId: "payout-1", action: "REJECTED" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_PROCESSED");
    // The refund that would otherwise double-pay the creator never happens.
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("cannot re-approve a request that is already approved", async () => {
    existing("APPROVED");

    const res = await review({ payoutId: "payout-1", action: "APPROVED" });

    expect(res.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
