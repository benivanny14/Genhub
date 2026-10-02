// =============================================================================
// GENHUB - The platform-wide "everything is free right now" switch
//
// What the switch must do, and what it must NOT do:
//   * while it is ON, a paid scene entitles EVERYONE — including a signed-out
//     visitor — with source "global"
//   * it grants, it does not sell: no purchase row is written, so turning it
//     off restores exactly what each account had
//   * is checked AFTER the free-price rule, so a genuinely free scene never
//     consults the settings store at all
//
// Prisma and the settings service are mocked: no database required.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  allVideosFree: vi.fn(),
  accessFindFirst: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    videoAccess: { findFirst: mocks.accessFindFirst, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
    user: { findUnique: mocks.userFindUnique },
  },
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  getAllVideosFree: () => mocks.allVideosFree(),
}));

import { resolveVideoEntitlement } from "@/lib/services/video-entitlement.service";

const VIDEO = { id: "row-1", price: 5000, creatorId: "creator-1" };
const VIEWER = { userId: "viewer-1", role: "VIEWER" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accessFindFirst.mockResolvedValue(null);
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.subscriptionFindFirst.mockResolvedValue(null);
  mocks.userFindUnique.mockResolvedValue({ freeAccess: false });
  mocks.accessUpsert.mockResolvedValue({ id: "access-1" });
});

describe("the platform-wide free switch", () => {
  it("entitles a signed-out visitor to a paid scene while it is on", async () => {
    mocks.allVideosFree.mockResolvedValue(true);

    expect(await resolveVideoEntitlement(VIDEO, null)).toEqual({
      entitled: true,
      source: "global",
      healed: false,
    });
  });

  it("grants without writing a purchase row", async () => {
    mocks.allVideosFree.mockResolvedValue(true);

    await resolveVideoEntitlement(VIDEO, VIEWER);

    // A grant is not a sale: nothing to take back when the switch is flipped off.
    expect(mocks.accessUpsert).not.toHaveBeenCalled();
  });

  it("restores the paywall the moment it is switched off", async () => {
    mocks.allVideosFree.mockResolvedValue(false);

    expect(await resolveVideoEntitlement(VIDEO, null)).toEqual({
      entitled: false,
      source: null,
      healed: false,
    });
  });

  it("does not consult the settings store for a genuinely free scene", async () => {
    await resolveVideoEntitlement({ ...VIDEO, price: 0 }, null);

    expect(mocks.allVideosFree).not.toHaveBeenCalled();
  });
});
