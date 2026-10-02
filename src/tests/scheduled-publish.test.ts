// =============================================================================
// GENHUB - The scheduled-publish sweep
//
// The property that matters: it publishes ONLY posts whose time has come, never
// a draft and never a future post, and clears scheduledAt so a second sweep does
// not see the same row again. Prisma and the cache are mocked.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: { video: { updateMany: mocks.updateMany } },
}));
vi.mock("@/lib/redis", () => ({ cacheDel: mocks.cacheDel }));

import { publishDueVideos } from "@/lib/services/scheduled-publish.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("publishDueVideos", () => {
  it("only considers unpublished, non-draft, non-deleted posts with a due time", async () => {
    const now = new Date("2026-06-01T20:00:00.000Z");
    await publishDueVideos(now);

    const arg = mocks.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      isPublished: false,
      isDraft: false,
      isDeleted: false,
      scheduledAt: { not: null, lte: now },
    });
  });

  it("marks published and clears the schedule so it cannot fire twice", async () => {
    await publishDueVideos(new Date());
    const arg = mocks.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ isPublished: true, scheduledAt: null });
  });

  it("does not touch the feed cache when nothing was due", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await publishDueVideos(new Date());
    expect(mocks.cacheDel).not.toHaveBeenCalled();
  });

  it("invalidates the feed cache when a post went live", async () => {
    mocks.updateMany.mockResolvedValue({ count: 2 });
    const published = await publishDueVideos(new Date());
    expect(published).toBe(2);
    expect(mocks.cacheDel).toHaveBeenCalledWith("videos:*");
  });

  it("never throws — a failed sweep must not break the feed read", async () => {
    mocks.updateMany.mockRejectedValue(new Error("db down"));
    await expect(publishDueVideos(new Date())).resolves.toBe(0);
  });
});
