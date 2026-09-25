// =============================================================================
// GENHUB - The admin audit log
//
// A ban, a KYC approval, a coupon and a payout approval all used to leave their
// record only as their consequence. `isBanned: true` has no author, `banReason`
// is NULLed by the next unban, and `payoutRequest.adminNote` is overwritten by
// the next decision — so "who suspended this creator, and why" had no answer
// anywhere in the system.
//
// These tests pin the behaviour that makes the log worth trusting rather than
// merely present:
//
//   1. the row says who acted, what they did, to what, and why;
//   2. recording NEVER fails the action it describes — a ban that succeeded must
//      not become a 500 because the log write failed, or the admin retries and
//      bans twice; the failure is printed instead, because a silent gap is worse
//      than a visible one;
//   3. it can join a transaction when the caller needs one commit; and
//   4. reading it back resolves the admin's NAME, from a table that deliberately
//      holds no foreign key to User.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    adminAuditLog: {
      create: (...a: unknown[]) => mocks.create(...a),
      findMany: (...a: unknown[]) => mocks.findMany(...a),
    },
    user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) },
  },
}));

import {
  AUDIT_ACTIONS,
  listAuditLog,
  recordAudit,
  recordAuditIn,
} from "@/lib/services/audit.service";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.create.mockResolvedValue({ id: "log-1" });
  mocks.findMany.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});

describe("recordAudit", () => {
  it("stores who did what, to what, and why", async () => {
    await recordAudit({
      actorId: "admin-1",
      action: AUDIT_ACTIONS.userBan,
      targetType: "User",
      targetId: "creator-1",
      summary: "Suspended Ivanny — reason: Terms violation",
      detail: { reason: "Terms violation", wasBanned: false },
    });

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        actorId: "admin-1",
        action: "user.ban",
        targetType: "User",
        targetId: "creator-1",
        summary: "Suspended Ivanny — reason: Terms violation",
        detail: { reason: "Terms violation", wasBanned: false },
      },
    });
  });

  it("does not fail the action when the log write fails", async () => {
    // The measured case this protects: the audit table missing on a deployment
    // that had not run its migration yet. Throwing here would turn a successful
    // ban into a 500, and the admin's retry would apply the ban twice.
    mocks.create.mockRejectedValue(new Error("relation \"AdminAuditLog\" does not exist"));

    await expect(
      recordAudit({ actorId: "admin-1", action: AUDIT_ACTIONS.userBan, summary: "Banned X" })
    ).resolves.toBeUndefined();
  });

  it("says so in the log when it could not record", async () => {
    mocks.create.mockRejectedValue(new Error("connection lost"));

    await recordAudit({ actorId: "admin-1", action: AUDIT_ACTIONS.userBan, summary: "Banned X" });

    // A silent gap is the failure this file exists to prevent: an operator
    // reading a list with holes in it trusts it.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("user.ban"),
      expect.anything()
    );
  });

  it("keeps a runaway summary from becoming the row", async () => {
    await recordAudit({
      actorId: "admin-1",
      action: AUDIT_ACTIONS.userBan,
      summary: "x".repeat(1200),
    });

    expect(mocks.create.mock.calls[0][0].data.summary).toHaveLength(500);
  });

  it("writes nulls rather than undefined for an optional target", async () => {
    await recordAudit({
      actorId: "admin-1",
      action: AUDIT_ACTIONS.paymentExpire,
      summary: "Released checkout locks",
    });

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.targetType).toBeNull();
    expect(data.targetId).toBeNull();
  });
});

describe("recordAuditIn", () => {
  it("writes through the caller's transaction, and also never throws", async () => {
    const tx = { adminAuditLog: { create: vi.fn().mockRejectedValue(new Error("deadlock")) } };

    await expect(
      recordAuditIn(tx as never, {
        actorId: "admin-1",
        action: AUDIT_ACTIONS.paymentRefund,
        summary: "Refunded TZS 5,000",
      })
    ).resolves.toBeUndefined();

    // The money move it describes must not be rolled back because a log line
    // could not be written.
    expect(tx.adminAuditLog.create).toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("listAuditLog", () => {
  it("returns newest first, capped, and names the admin without a foreign key", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "log-1",
        actorId: "admin-1",
        action: "user.ban",
        summary: "Suspended Ivanny",
        targetType: "User",
        targetId: "creator-1",
        detail: null,
        createdAt: new Date("2026-09-25T10:00:00Z"),
      },
    ]);
    mocks.userFindMany.mockResolvedValue([
      { id: "admin-1", displayName: "Benny", email: "benny@example.com" },
    ]);

    const entries = await listAuditLog({ take: 50 });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" }, take: 50 })
    );
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["admin-1"] } },
      select: { id: true, displayName: true, email: true },
    });
    expect(entries[0]).toMatchObject({
      action: "user.ban",
      summary: "Suspended Ivanny",
      actorName: "Benny",
      actorEmail: "benny@example.com",
    });
  });

  it("filters by an action prefix, so `payout.` is one query", async () => {
    await listAuditLog({ action: "payout.", take: 10 });

    expect(mocks.findMany.mock.calls[0][0].where.action).toEqual({ startsWith: "payout." });
  });

  it("caps what one request can ask for", async () => {
    await listAuditLog({ take: 10_000 });

    expect(mocks.findMany.mock.calls[0][0].take).toBe(500);
  });

  it("does not query users when there are no entries", async () => {
    mocks.findMany.mockResolvedValue([]);

    expect(await listAuditLog()).toEqual([]);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("survives an admin whose account no longer exists", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "log-1",
        actorId: "deleted-admin",
        action: "user.ban",
        summary: "Suspended Ivanny",
        targetType: "User",
        targetId: "creator-1",
        detail: null,
        createdAt: new Date(),
      },
    ]);
    mocks.userFindMany.mockResolvedValue([]);

    const entries = await listAuditLog();

    // The record of what was done must outlive the account that did it, which is
    // exactly why actorId is not a foreign key.
    expect(entries[0].actorName).toBeNull();
    expect(entries[0].actorId).toBe("deleted-admin");
  });
});

describe("action codes", () => {
  it("are dotted and unique, so one prefix can select a family", () => {
    const codes = Object.values(AUDIT_ACTIONS);

    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
});
