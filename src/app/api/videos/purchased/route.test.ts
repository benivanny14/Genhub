// =============================================================================
// GENHUB - Tests for GET /api/videos/purchased
//
// This route is what lets a card say PAID instead of quoting a price again, so
// the two ways it can be wrong are both pinned here:
//
//   * it must report ONLY live access (a lifetime row, or a rental that has not
//     run out) — an expired row is not a purchase and must not hide the price;
//   * it must be per-viewer and never cacheable — a cache handing one fan's
//     purchase list to the next visitor would tell them what somebody else
//     bought.
//
// Signed out is an empty list, not an error: a visitor who cannot buy anything
// has nothing marked, and a 401 here would be noise on every public page.
//
// Prisma and auth are mocked: no database, no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/db", () => ({
  default: { videoAccess: { findMany: mocks.findMany } },
}));

import { GET } from "./route";

describe("GET /api/videos/purchased", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("answers an empty list for a signed-out visitor, without touching the database", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.videoIds).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns the viewer's live access ids", async () => {
    mocks.getCurrentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    mocks.findMany.mockResolvedValue([{ videoId: "v1" }, { videoId: "v2" }]);

    const body = await (await GET()).json();

    expect(body.data.videoIds).toEqual(["v1", "v2"]);
    // Scoped to THIS viewer, and only to live rows — an expired rental must not
    // read as owned, or the card would hide a price the viewer has to pay again.
    expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({
      viewerId: "viewer-1",
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it("marks the answer private so no cache serves one viewer's list to another", async () => {
    mocks.getCurrentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });

    const res = await GET();

    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("fails closed to an error the client treats as \"no purchases known\"", async () => {
    mocks.getCurrentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    mocks.findMany.mockRejectedValue(new Error("db down"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
});
