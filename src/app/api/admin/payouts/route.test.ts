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
  disburse: vi.fn(),
  // The floor the GATEWAY enforces, which the route reports to the queue. Mocked
  // with the other half of the service so this file stays a test of the route's
  // decisions, not of the gateway.
  gatewayFloor: vi.fn(() => 30_000),
}));

// The gateway half is exercised in src/tests/payout-disbursement.test.ts. Here
// only its VERDICT matters, because the decision this route makes about a
// verdict is the thing under test.
vi.mock("@/lib/services/payout-disbursement.service", () => ({
  disbursePayout: (...a: unknown[]) => mocks.disburse(...a),
  gatewayMinPayout: () => mocks.gatewayFloor(),
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

  it("reports the gateway's own floor, so a small withdrawal can be called one", async () => {
    // The queue has to say "this one will have to be sent by hand" next to an
    // amount the gateway refuses. It quotes the gateway's number, read from the
    // service here rather than written into the admin screen — and the gateway's
    // floor is not Genhub's waivable one, which is why it travels separately.
    mocks.gatewayFloor.mockReturnValue(45_000);

    const body = await (await get("?status=PENDING,APPROVED")).json();

    expect(body.data.gatewayMinimum).toBe(45_000);
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

  it("completes an approved request, storing the receipt the admin was given", async () => {
    existing("APPROVED");

    const res = await review({
      payoutId: "payout-1",
      action: "PAID",
      paymentReference: "QGR7X8Y2Z1",
    });

    expect(res.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("PAID");
    // The receipt is the record the creator checks the money against, so it has
    // to reach the row and the audit line, not just the request.
    expect(mocks.update.mock.calls[0][0].data.paymentReference).toBe("QGR7X8Y2Z1");
    expect(mocks.audit.mock.calls[0][0].detail.paymentReference).toBe("QGR7X8Y2Z1");
    // Sending money does not put any back: only a rejection credits the balance.
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][0].action).toBe("payout.paid");
  });

  it("refuses to mark a payout paid without a receipt number", async () => {
    existing("APPROVED");

    const res = await review({ payoutId: "payout-1", action: "PAID" });
    const body = await res.json();

    // "Paid" with nothing to check it against is an assertion, not a record —
    // which is what this whole field exists to stop.
    expect(res.status).toBe(422);
    expect(body.error).toContain("receipt");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("treats a blank receipt as no receipt", async () => {
    existing("APPROVED");

    const res = await review({ payoutId: "payout-1", action: "PAID", paymentReference: "   " });

    expect(res.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a receipt that is not a transaction code", async () => {
    // A real, observed abuse: a payout was marked PAID with the reference
    // "moi sasha" — the creator's own name. The balance dropped and the record
    // said the money had gone, with nothing behind it. A code contains digits;
    // a name does not.
    existing("APPROVED");

    const res = await review({
      payoutId: "payout-1",
      action: "PAID",
      paymentReference: "moi sasha",
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toMatch(/receipt/i);
    expect(mocks.update).not.toHaveBeenCalled();
    // The one thing that must never happen: money recorded as sent without a
    // way to prove it was.
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("accepts a normal M-Pesa receipt", async () => {
    existing("APPROVED");

    const res = await review({
      payoutId: "payout-1",
      action: "PAID",
      paymentReference: "QGR7X8Y2Z1",
    });

    expect(res.status).toBe(200);
  });

  it("returns the money and nothing else when a request is rejected", async () => {
    existing("PENDING");

    const res = await review({ payoutId: "payout-1", action: "REJECTED" });

    expect(res.status).toBe(200);
    expect(mocks.balanceUpdate.mock.calls[0][0]).toMatchObject({
      where: { creatorId: "creator-1" },
      data: { availableBalance: { increment: 100_000 } },
    });
    // Nothing was sent, so a rejection writes no receipt — it must not overwrite
    // a reference it does not own with an empty string.
    expect(mocks.update.mock.calls[0][0].data.paymentReference).toBeUndefined();
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

  it("approves a below-floor withdrawal the gateway will not send, instead of erroring", async () => {
    // The real case: an admin waives Genhub's TZS 30,000 floor for one creator,
    // who then asks for the TZS 1,000 they hold. Approving it cannot be sent
    // automatically — the gateway's own limit is TZS 30,000 — but the money is
    // perfectly payable by hand, so the decision is recorded and the admin is
    // told what to do. Answering with an error made it look impossible.
    existing("PENDING");
    mocks.disburse.mockResolvedValue({
      ok: false,
      reason: "BELOW_GATEWAY_MINIMUM",
      message:
        "Automatic payouts cannot send less than TZS 30,000 — that is the payment gateway's own limit, not Genhub's, and it cannot be lifted from here.",
    });

    const res = await review({ payoutId: "payout-1", action: "APPROVED" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("APPROVED");
    // The admin's only confirmation, so it says why nothing was sent and what to
    // do instead.
    expect(body.message).toContain("30,000");
    expect(body.message).toMatch(/send it yourself/i);
    // Approving does not move money: the amount stays earmarked.
    expect(mocks.balanceUpdate).not.toHaveBeenCalled();
  });

  it("still errors when the gateway refuses for a reason a human cannot fix by paying", async () => {
    // The distinction that keeps the fallback honest: only a reason that leaves
    // the money payable by hand is treated as one.
    existing("PENDING");
    mocks.disburse.mockResolvedValue({
      ok: false,
      reason: "GATEWAY",
      message: "Invalid account",
    });

    const res = await review({ payoutId: "payout-1", action: "APPROVED" });

    expect(res.status).toBe(502);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
