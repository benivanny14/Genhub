// =============================================================================
// GENHUB - Support tickets
//
// The form this replaces had no backend: it opened a `mailto:` link, so a ticket
// that never left the browser looked exactly like one that arrived. The rule
// worth pinning is therefore not "does it send an email" but "does it ever claim
// a message was delivered when nothing received it".
//
// Asserted here:
//   1. A ticket goes out by email AND to the admin bell.
//   2. Either channel landing is enough — a mail host with no SMTP configured
//      must not lose the ticket when an admin can still be told.
//   3. When NOTHING received it, the answer is a 503 that names a way to reach
//      support, never a success.
//   4. A signed-out ticket must carry an address to reply to.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  getCurrentUser: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany },
    notification: { createMany: mocks.notificationCreateMany },
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: 0 })),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@/lib/email", () => ({
  sendMail: mocks.sendMail,
}));

vi.mock("@/lib/config", () => ({
  default: { compliance: { supportEmail: "support@genhub.example" } },
}));

import { POST as support } from "@/app/api/support/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/support", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  }) as never;

const ticket = { topic: "Payment issue", subject: "Charged twice", message: "Two collect requests arrived." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue(null);
  mocks.userFindMany.mockResolvedValue([{ id: "admin-1" }, { id: "admin-2" }]);
  mocks.notificationCreateMany.mockResolvedValue({ count: 2 });
  mocks.sendMail.mockResolvedValue({ sent: true, transport: "smtp" });
});

describe("sending a support ticket", () => {
  it("emails support and rings the admin bell", async () => {
    mocks.getCurrentUser.mockResolvedValue({ userId: "u1", role: "VIEWER" });
    mocks.userFindUnique.mockResolvedValue({
      id: "u1",
      email: "fan@example.com",
      displayName: "Fan",
      role: "VIEWER",
    });

    const response = await support(post(ticket));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.delivered).toEqual({ email: true, admins: 2 });

    const mail = mocks.sendMail.mock.calls[0][0];
    expect(mail.to).toBe("support@genhub.example");
    // The reply must go to the visitor, not back to the support inbox.
    expect(mail.replyTo).toBe("fan@example.com");
    expect(mail.subject).toContain("Charged twice");

    expect(mocks.notificationCreateMany).toHaveBeenCalledTimes(1);
    const rows = mocks.notificationCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toContain("Two collect requests");
  });

  it("still delivers to the admins when no mail host is configured", async () => {
    // transport "console" means the message only reached the server log. That is
    // not a delivered ticket, but the bell still is one.
    mocks.sendMail.mockResolvedValue({ sent: true, transport: "console" });

    const response = await support(post({ ...ticket, email: "fan@example.com" }));

    expect(response.status).toBe(200);
    expect((await response.json()).data.delivered).toEqual({ email: false, admins: 2 });
  });

  it("reports failure when nothing received the ticket", async () => {
    mocks.sendMail.mockResolvedValue({ sent: false, transport: "console" });
    mocks.userFindMany.mockResolvedValue([]);

    const response = await support(post({ ...ticket, email: "fan@example.com" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain("support@genhub.example");
  });

  it("requires a reply address when the visitor is not signed in", async () => {
    const response = await support(post(ticket));

    expect(response.status).toBe(422);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("rejects a ticket with nothing in it", async () => {
    expect((await support(post({ topic: "x", subject: "hi", message: "short" }))).status).toBe(422);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});
