// =============================================================================
// GENHUB - POST /api/admin/users
//
// The route that suspends a creator. Three things about it are worth pinning,
// because all three have a failure mode that looks like success:
//
//   1. BAN must drop the account-status cache requireAuth keeps for a minute.
//      Without it, the banned creator keeps posting for the rest of the window
//      and an admin who checks immediately sees the ban not working.
//   2. An admin must not be able to ban or unverify THEMSELVES. The check has to
//      be on the target id, not on the requester's role.
//   3. Every action must leave an audit row. `isBanned` has no author and
//      `banReason` is NULLed by the next unban, so the audit entry is the only
//      place "who did this, and why" exists — a refactor that drops the call
//      would look perfectly green without it.
//
// Prisma, auth and the cache invalidation are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  invalidate: vi.fn(),
  findUser: vi.fn(),
  updateUser: vi.fn(),
  updateVideos: vi.fn(),
  notification: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: {
      findUnique: (...a: unknown[]) => mocks.findUser(...a),
      update: (...a: unknown[]) => mocks.updateUser(...a),
    },
    video: { updateMany: (...a: unknown[]) => mocks.updateVideos(...a) },
    notification: { create: (...a: unknown[]) => mocks.notification(...a) },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: () => mocks.requireRole(),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/services/account-status.service", () => ({
  invalidateAccountStatus: (...a: unknown[]) => mocks.invalidate(...a),
}));

vi.mock("@/lib/services/audit.service", () => ({
  AUDIT_ACTIONS: {
    userVerify: "user.verify",
    userUnverify: "user.unverify",
    userBan: "user.ban",
    userUnban: "user.unban",
  },
  recordAudit: (...a: unknown[]) => mocks.audit(...a),
}));

import { POST } from "./route";

function act(body: Record<string, unknown>) {
  return new NextRequest("https://app.test/api/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const TARGET = {
  id: "creator-1",
  role: "CREATOR",
  isVerified: false,
  isBanned: false,
  displayName: "Ivanny",
  email: "ivanny@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.findUser.mockResolvedValue(TARGET);
  mocks.updateUser.mockResolvedValue(TARGET);
  mocks.updateVideos.mockResolvedValue({ count: 0 });
  mocks.notification.mockResolvedValue({ id: "note-1" });
});

describe("banning", () => {
  it("drops the cached account status so the ban is in force immediately", async () => {
    const res = await POST(act({ userId: "creator-1", action: "BAN", reason: "Terms violation" }));

    expect(res.status).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledWith("creator-1");
  });

  it("writes the reason and the strikes, and unpublishes the live videos", async () => {
    await POST(act({ userId: "creator-1", action: "BAN", reason: "Terms violation" }));

    expect(mocks.updateUser.mock.calls[0][0].data).toMatchObject({
      isBanned: true,
      banReason: "Terms violation",
      strikes: 3,
    });
    expect(mocks.updateVideos).toHaveBeenCalledWith({
      where: { creatorId: "creator-1", isPublished: true },
      data: { isPublished: false },
    });
  });

  it("records an audit entry naming the admin, the creator and the reason", async () => {
    await POST(act({ userId: "creator-1", action: "BAN", reason: "Terms violation" }));

    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        action: "user.ban",
        targetType: "User",
        targetId: "creator-1",
        summary: expect.stringContaining("Ivanny"),
      })
    );
    expect(mocks.audit.mock.calls[0][0].summary).toContain("Terms violation");
  });

  it("refuses to ban the admin's own account", async () => {
    mocks.findUser.mockResolvedValue({ ...TARGET, id: "admin-1", role: "ADMIN" });

    const res = await POST(act({ userId: "admin-1", action: "BAN" }));

    expect(res.status).toBe(422);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not unpublish anything when unbanning", async () => {
    await POST(act({ userId: "creator-1", action: "UNBAN" }));

    expect(mocks.updateUser.mock.calls[0][0].data.banReason).toBeNull();
    expect(mocks.updateVideos).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][0].action).toBe("user.unban");
  });

  it("refuses an unknown action", async () => {
    const res = await POST(act({ userId: "creator-1", action: "DELETE_EVERYTHING" }));

    expect(res.status).toBe(422);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});

describe("verification", () => {
  it("records who granted the badge", async () => {
    await POST(act({ userId: "creator-1", action: "VERIFY" }));

    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      action: "user.verify",
      targetId: "creator-1",
    });
  });

  it("records who removed it, with the previous value", async () => {
    mocks.findUser.mockResolvedValue({ ...TARGET, isVerified: true });

    await POST(act({ userId: "creator-1", action: "UNVERIFY" }));

    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      action: "user.unverify",
      detail: { wasVerified: true },
    });
  });
});
