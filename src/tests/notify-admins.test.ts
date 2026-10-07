// =============================================================================
// GENHUB - Tell every admin
//
// One alert to all admins is now one call, and the ways it goes wrong are quiet:
//
//   1. An admin who left — or was banned — keeps being told, or the alert is
//      addressed to a hard-coded id that no longer exists while the real admins
//      hear nothing.
//   2. NOBODY is told, and the failure is invisible: the request sits in a queue
//      with no reader. That is the case this logs loudly for.
//   3. One bad write stops the rest. The first admin's notification failing must
//      not rob the second one of theirs.
//   4. It throws, and takes down the thing that already happened — the payout
//      request is on the record whether or not the bell rings.
//
// Prisma and the push mirror are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  notificationCreate: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) },
    notification: { create: (...a: unknown[]) => mocks.notificationCreate(...a) },
  },
}));

vi.mock("@/lib/services/push.service", () => ({
  sendPushToUser: (...a: unknown[]) => mocks.push(...a),
}));

import { notifyAdmins } from "@/lib/services/notify.service";

const alert = {
  title: "Withdrawal request 💸",
  message: "Amina asked to withdraw TZS 100,000.",
  type: "info",
  link: "/admin",
  pushTag: "payout-request",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationCreate.mockResolvedValue({ id: "n1" });
  mocks.push.mockResolvedValue(undefined);
  mocks.userFindMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyAdmins", () => {
  it("tells every admin who can act, in one row each", async () => {
    const told = await notifyAdmins(alert);

    expect(told).toBe(2);
    // The query is the rule: it asks for the role, not for a list of ids that
    // goes stale the moment somebody is added or removed.
    const where = mocks.userFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ role: "ADMIN" });
    expect(where).not.toHaveProperty("id");

    expect(mocks.notificationCreate).toHaveBeenCalledTimes(2);
    expect(mocks.notificationCreate.mock.calls.map((c) => c[0].data.userId)).toEqual([
      "admin-1",
      "admin-2",
    ]);
    // The alert arrives as written, link and all: the tap has to land on the
    // queue the admin acts in.
    expect(mocks.notificationCreate.mock.calls[0][0].data).toMatchObject({
      title: alert.title,
      message: alert.message,
      type: "info",
      link: "/admin",
    });
    // Each admin's device is mirrored too, not only their bell.
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it("says so loudly when there is nobody to tell", async () => {
    mocks.userFindMany.mockResolvedValue([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const told = await notifyAdmins(alert);

    expect(told).toBe(0);
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
    // A queue nobody can be told about is the failure this feature exists to
    // prevent, so it is not allowed to pass in silence.
    expect(error.mock.calls.flat().join(" ")).toContain("no ADMIN account");
  });

  it("keeps going when one admin cannot be told", async () => {
    mocks.notificationCreate.mockImplementation(async ({ data }: { data: { userId: string } }) => {
      if (data.userId === "admin-1") throw new Error("write refused");
      return { id: "n2" };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const told = await notifyAdmins(alert);

    // Counted, not thrown: the second admin's notification is not collateral.
    expect(told).toBe(2);
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(2);
  });

  it("never throws, even when the admin list cannot be read", async () => {
    mocks.userFindMany.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // It runs after the request has already been recorded; a broken alert must
    // not turn a creator's withdrawal into a 500.
    await expect(notifyAdmins(alert)).resolves.toBe(0);
  });
});
