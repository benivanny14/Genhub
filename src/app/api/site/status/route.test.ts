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
  getBackgroundVideo: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  getFeatureFlags: mocks.getFeatureFlags,
  getAnnouncement: mocks.getAnnouncement,
  getAllVideosFree: mocks.getAllVideosFree,
  getBackgroundVideo: mocks.getBackgroundVideo,
}));

import { GET } from "./route";

describe("GET /api/site/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFeatureFlags.mockResolvedValue({ uploadsEnabled: true, checkoutEnabled: true });
    mocks.getAnnouncement.mockResolvedValue({ active: false, message: "", tone: "danger" });
    mocks.getBackgroundVideo.mockResolvedValue({
      active: false,
      token: "",
      mimeType: "",
      name: "",
      size: 0,
    });
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

  // The backdrop is read from here too, so a browser learns about it on the
  // same read that tells it whether to show prices. With it missing, the layer
  // would never mount and an operator's upload would look like it had done
  // nothing.
  it("carries the background clip, so the layer has somewhere to load it from", async () => {
    mocks.getAllVideosFree.mockResolvedValue(false);
    mocks.getBackgroundVideo.mockResolvedValue({
      active: true,
      token: "0123456789abcdef01234567",
      mimeType: "video/mp4",
      name: "hero.mp4",
      size: 1024,
    });

    const body = await (await GET()).json();

    expect(body.data.backgroundVideo).toEqual({
      active: true,
      token: "0123456789abcdef01234567",
      mimeType: "video/mp4",
      name: "hero.mp4",
      size: 1024,
    });
  });
});
