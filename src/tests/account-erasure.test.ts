// =============================================================================
// GENHUB - Erasing an account
//
// "Delete my account" is the only irreversible thing a user can ask for, and the
// ways it goes wrong are all quiet:
//
//   · It half-happens. Prisma cascades only where the schema says so; a user's
//     videos, their transactions, the reports they filed and the messages they
//     sent hold a required foreign key. Delete the user first and the whole
//     transaction aborts — the user is told their account is gone while every row
//     is still there.
//   · It takes the deployment with it. An admin erasing the last admin account
//     leaves a site nobody can administer.
//   · It lies about the leftovers. Bunny can be unreachable; that must not stop
//     the database part, and it must not be reported as success either.
//
// The database and Bunny are mocked, so the ORDER and the GUARDS are what is
// checked — no rows are touched.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  default: {
    bunny: {
      storageZone: "genhub-thumbs",
      storageAccessKey: "storage-key",
      apiKey: "stream-key",
      cdnHostname: "vz-test.b-cdn.net",
    },
  },
}));

// vi.mock factories are hoisted above the imports, so everything they close over
// has to be created by vi.hoisted — a plain top-level `const` is not initialised
// yet when the factory runs.
const h = vi.hoisted(() => {
  const order: string[] = [];

  const table = (name: string, count = 1) => ({
    deleteMany: vi.fn(async () => {
      order.push(name);
      return { count };
    }),
    updateMany: vi.fn(async () => {
      order.push(name);
      return { count };
    }),
  });

  const tx = {
    videoReport: table("videoReport.deleteMany"),
    video: table("video.deleteMany"),
    transaction: { deleteMany: table("transaction.deleteMany").deleteMany, updateMany: table("transaction.updateMany").updateMany },
    payoutRequest: table("payoutRequest.deleteMany"),
    kycVerification: table("kycVerification.updateMany"),
    payMessage: table("payMessage.deleteMany"),
    user: { updateMany: table("user.updateMany").updateMany, deleteMany: table("user.deleteMany").deleteMany },
  };

  return {
    order,
    tx,
    videoFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    userCount: vi.fn(),
  };
});

const { order, tx } = h;
const videoFindMany = h.videoFindMany;
const userFindUnique = h.userFindUnique;
const userCount = h.userCount;

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: h.userFindUnique, count: h.userCount },
    video: { findMany: h.videoFindMany },
    $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(h.tx)),
  },
}));

vi.mock("@/lib/bunny", () => ({
  isBunnyVideoId: (id: string) => /^[0-9a-f-]{36}$/i.test(id),
  deleteBunnyVideo: vi.fn(async () => undefined),
}));

import { deleteBunnyVideo } from "@/lib/bunny";
import { canEraseAccount, eraseAccount } from "@/lib/services/account-erasure.service";

const deleteBunny = vi.mocked(deleteBunnyVideo);

const GUID = "39ea50b0-bee6-4175-90fe-99710ecc3848";

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  userFindUnique.mockResolvedValue({ avatarUrl: "/api/media/public/images/a.jpg" });
  videoFindMany.mockResolvedValue([]);
  userCount.mockResolvedValue(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response)
  );
});

describe("canEraseAccount", () => {
  it("lets an ordinary user leave", async () => {
    expect(await canEraseAccount("u1", "CREATOR")).toEqual({ allowed: true });
    // No admin lookup is even needed.
    expect(userCount).not.toHaveBeenCalled();
  });

  it("lets an admin leave while another admin remains", async () => {
    userCount.mockResolvedValue(2);
    expect(await canEraseAccount("u1", "ADMIN")).toEqual({ allowed: true });
  });

  it("refuses the last admin, and says what to do about it", async () => {
    userCount.mockResolvedValue(1);
    const verdict = await canEraseAccount("u1", "ADMIN");
    expect(verdict.allowed).toBe(false);
    // The message is the whole point of the refusal: it has to name the way out.
    expect(verdict.reason).toMatch(/only admin/i);
    expect(verdict.reason).toMatch(/admin first/i);
  });
});

describe("eraseAccount", () => {
  it("deletes the reports and the videos before the user", async () => {
    videoFindMany.mockResolvedValue([
      { id: "v1", title: "One", bunnyVideoId: GUID, thumbnailUrl: null },
    ]);

    await eraseAccount("u1");

    // VideoReport.video has no cascade, so it is what would block the video
    // delete — and the videos are what would block the user delete.
    expect(order.indexOf("videoReport.deleteMany")).toBeLessThan(order.indexOf("video.deleteMany"));
    expect(order.indexOf("video.deleteMany")).toBeLessThan(order.indexOf("user.deleteMany"));
    // The account row goes last, in the same transaction as everything else.
    expect(order[order.length - 1]).toBe("user.deleteMany");
  });

  it("keeps a buyer's receipt and cuts the creator link instead", async () => {
    await eraseAccount("u1");
    expect(order).toContain("transaction.deleteMany");
    expect(order).toContain("transaction.updateMany");
  });

  it("detaches referrals and admin review history without deleting the other party", async () => {
    await eraseAccount("u1");
    expect(order).toContain("kycVerification.updateMany");
    expect(order).toContain("user.updateMany");
  });

  it("removes the video from Bunny and reports how many went", async () => {
    videoFindMany.mockResolvedValue([
      { id: "v1", title: "One", bunnyVideoId: GUID, thumbnailUrl: null },
      { id: "v2", title: "Two", bunnyVideoId: GUID, thumbnailUrl: null },
    ]);
    const report = await eraseAccount("u1");
    expect(deleteBunny).toHaveBeenCalledTimes(2);
    expect(report.videosRemoved).toBe(2);
  });

  it("does not ask Bunny to delete a row that was never a real video", async () => {
    videoFindMany.mockResolvedValue([
      { id: "v1", title: "Demo", bunnyVideoId: "demo-1", thumbnailUrl: null },
    ]);
    const report = await eraseAccount("u1");
    expect(deleteBunny).not.toHaveBeenCalled();
    expect(report.videosRemoved).toBe(0);
  });

  it("finishes the database work even when Bunny is unreachable, and says so", async () => {
    videoFindMany.mockResolvedValue([
      { id: "v1", title: "One", bunnyVideoId: GUID, thumbnailUrl: null },
    ]);
    deleteBunny.mockRejectedValueOnce(new Error("Bunny is down"));

    const report = await eraseAccount("u1");

    expect(report.failures.join(" ")).toMatch(/Bunny is down/);
    // The account still goes: an outage at the video host is not the user's
    // problem, and trapping them in an account they asked to leave is worse.
    expect(order[order.length - 1]).toBe("user.deleteMany");
  });

  it("deletes the thumbnails and the avatar, and never another user's document", async () => {
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleted.push(String(url));
          return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        }
        // Directory listings, answered the way Bunny does: the owner folder
        // contains the `kyc` subfolder, which contains the documents.
        const listing = String(url).includes("/kyc/") ? ["id.png"] : ["kyc"];
        return {
          ok: true,
          status: 200,
          json: async () =>
            listing.map((name) => ({
              ObjectName: name,
              IsDirectory: !name.includes("."),
            })),
        } as unknown as Response;
      })
    );

    videoFindMany.mockResolvedValue([
      {
        id: "v1",
        title: "One",
        bunnyVideoId: GUID,
        thumbnailUrl: "/api/media/uploads/2026-09/thumb.jpg",
      },
    ]);

    await eraseAccount("u1");

    expect(deleted.some((u) => u.endsWith("/uploads/2026-09/thumb.jpg"))).toBe(true);
    expect(deleted.some((u) => u.endsWith("/public/images/a.jpg"))).toBe(true);
    // Found by walking the folder, not from a row: a document whose row was
    // superseded still has to go.
    expect(deleted.some((u) => u.endsWith("/private/u1/kyc/id.png"))).toBe(true);
  });

  it("does not delete a key outside the user's own private folder", async () => {
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleted.push(String(url));
          return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      })
    );

    // A video row pointing at somebody ELSE's identity document. Corrupt data
    // must not turn erasure into a way to destroy another person's file.
    videoFindMany.mockResolvedValue([
      {
        id: "v1",
        title: "One",
        bunnyVideoId: GUID,
        thumbnailUrl: "/api/media/private/someone-else/kyc/id.png",
      },
    ]);

    const report = await eraseAccount("u1");
    expect(deleted.some((u) => u.includes("someone-else"))).toBe(false);
    expect(deleted.some((u) => u.includes("private/u1"))).toBe(false);
    expect(report.failures.join(" ")).toContain("someone-else");
  });

  it("counts what it removed so the user can be told", async () => {
    const report = await eraseAccount("u1");
    expect(report.removed.account).toBe(1);
    expect(report.removed.messages).toBe(1);
  });
});
