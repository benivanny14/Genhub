// =============================================================================
// GENHUB - Web Push service
//
// Two properties worth pinning: with no VAPID keys push is a silent no-op (so a
// deployment that never configured it is not broken), and a subscription the
// push service has forgotten (404/410) is pruned instead of retried forever.
// web-push and Prisma are mocked — no browser, no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    pushSubscription: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
  },
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: mocks.setVapidDetails,
    sendNotification: mocks.sendNotification,
  },
}));

import {
  isPushConfigured,
  getVapidPublicKey,
  sendPushToUser,
} from "@/lib/services/push.service";

const env = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  mocks.findMany.mockResolvedValue([]);
  mocks.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  // `web-push` lazily configures VAPID once; a configured run must not leak into
  // the unconfigured test.
  vi.resetModules();
  process.env = { ...env };
});

describe("push when unconfigured", () => {
  it("reports itself as off", () => {
    expect(isPushConfigured()).toBe(false);
    expect(getVapidPublicKey()).toBeNull();
  });

  it("sends nothing and never touches the database", async () => {
    const result = await sendPushToUser("user-1", { title: "Hi", body: "There" });
    expect(result).toEqual({ sent: 0, removed: 0, skipped: true });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("push when configured", () => {
  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    vi.resetModules();
  });

  it("sends to every device and reports how many", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "s1", endpoint: "https://push/1", p256dh: "p1", auth: "a1" },
      { id: "s2", endpoint: "https://push/2", p256dh: "p2", auth: "a2" },
    ]);
    mocks.sendNotification.mockResolvedValue({ statusCode: 201 });

    const result = await sendPushToUser("user-1", { title: "Hi", body: "There" });
    expect(result.sent).toBe(2);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("prunes an endpoint the push service says is gone", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "s1", endpoint: "https://push/1", p256dh: "p1", auth: "a1" },
    ]);
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    const result = await sendPushToUser("user-1", { title: "Hi", body: "There" });
    expect(result.sent).toBe(0);
    expect(result.removed).toBe(1);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s1"] } } });
  });
});
