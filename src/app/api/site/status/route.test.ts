// =============================================================================
// GENHUB - Tests for GET /api/site/status
//
// The route is what the viewer-facing screens read to decide whether to show a
// price. `allVideosFree` must ride along with the banner and the kill switches:
// with it missing, every card, shelf and history row would quote a price for a
// scene the platform is giving away — which is exactly the bug this pins.
//
// The settings service is mocked: no database, no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeatureFlags: vi.fn(),
  getAnnouncement: vi.fn(),
  getAllVideosFree: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  getFeatureFlags: mocks.getFeatureFlags,
  getAnnouncement: mocks.getAnnouncement,
  getAllVideosFree: mocks.getAllVideosFree,
}));

import { GET } from "./route";

describe("GET /api/site/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFeatureFlags.mockResolvedValue({ uploadsEnabled: true, checkoutEnabled: true });
    mocks.getAnnouncement.mockResolvedValue({ active: false, message: "", tone: "danger" });
  });

  it("reports the free-views switch on, so prices can be hidden", async () => {
    mocks.getAllVideosFree.mockResolvedValue(true);

    const body = await (await GET()).json();

    expect(body.success).toBe(true);
    expect(body.data.allVideosFree).toBe(true);
  });

  it("reports paid when the switch is off", async () => {
    mocks.getAllVideosFree.mockResolvedValue(false);

    const body = await (await GET()).json();

    expect(body.data.allVideosFree).toBe(false);
  });
});
