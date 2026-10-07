// =============================================================================
// GENHUB - /api/notifications
//
// The endpoint behind both surfaces that show a person what Genhub and its
// admins have told them: the bell and /notifications. Three things have to hold,
// and each one was a way this could lie:
//
//   1. A READ IS ALWAYS SCOPED TO THE READER. The bell asks on every page of the
//      site and the page asks for 200 rows; an unscoped read would hand anybody
//      the admin notes written to everyone else.
//   2. HOW MUCH IS RETURNED IS THE SERVER'S DECISION. The page asks for 200 and
//      gets at most that; a query string cannot ask for the whole table.
//   3. MARKING READ CANNOT REACH ANOTHER PERSON'S ROW. The id comes from the
//      browser, so the update is scoped by userId as well as by id — otherwise
//      any signed-in user could clear somebody else's unread dot.
//
// Prisma, auth and the rate limiter are mocked; no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    notification: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      count: (...a: unknown[]) => mocks.count(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
}));

import { GET, PATCH } from "./route";

function get(query = "") {
  return GET(new NextRequest(`https://app.test/api/notifications${query}`));
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("https://app.test/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "user-1", role: "CREATOR" });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/notifications", () => {
  it("returns only the reader's own notifications, newest first", async () => {
    await get();

    const query = mocks.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: "user-1" });
    expect(query.orderBy).toEqual({ createdAt: "desc" });
  });

  it("answers with the unread count the bell's badge needs", async () => {
    mocks.count.mockResolvedValue(3);

    const body = await (await get()).json();

    expect(mocks.count.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      isRead: false,
    });
    expect(body.data.unreadCount).toBe(3);
  });

  it("keeps the bell's default read small", async () => {
    await get();

    expect(mocks.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("lets the notifications page ask for its history, up to the ceiling", async () => {
    // The page is the record — the place a creator reads the reason their
    // withdrawal was rejected. Stopping it at a drop-down's worth of rows is
    // what made those words unreachable.
    await get("?limit=200");

    expect(mocks.findMany.mock.calls[0][0].take).toBe(200);
  });

  it("does not let a query string turn this into an unbounded read", async () => {
    await get("?limit=100000");

    expect(mocks.findMany.mock.calls[0][0].take).toBe(200);
  });

  it("ignores a nonsense limit instead of failing the read", async () => {
    await get("?limit=banana");

    expect(mocks.findMany.mock.calls[0][0].take).toBe(50);
  });
});

describe("PATCH /api/notifications", () => {
  it("with no id, marks everything of the reader's unread as read", async () => {
    await patch({});

    expect(mocks.updateMany.mock.calls[0][0]).toEqual({
      where: { userId: "user-1", isRead: false },
      data: { isRead: true },
    });
  });

  it("with an id, marks that one — still only within the reader's own rows", async () => {
    // The scope is the point: the id arrives from the browser, so matching on it
    // alone would let any signed-in user clear somebody else's unread dot.
    await patch({ id: "notif-9" });

    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      isRead: false,
      id: "notif-9",
    });
  });

  it("ignores a non-string id rather than passing it to the query", async () => {
    await patch({ id: { $ne: null } });

    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      isRead: false,
    });
  });

  it("refuses a flood of marks", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await patch({});

    expect(res.status).toBe(429);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
