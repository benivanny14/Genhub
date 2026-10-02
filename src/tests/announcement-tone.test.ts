// =============================================================================
// GENHUB - The announcement banner's colour
//
// The banner exists to be noticed ("malipo yamerudi", "tunafanya matengenezo"),
// so the server's default tone is the loud red one — and an UNKNOWN tone must
// fall back to red rather than to the quiet blue. The failure this pins: an
// operator publishes an urgent announcement, the stored tone is one the reader
// does not know, and it renders as a tinted note nobody stops for.
// =============================================================================

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ default: {} }));

import { normalizeAnnouncementTone } from "@/lib/services/platform-setting.service";

describe("normalizeAnnouncementTone", () => {
  it("keeps every tone it knows", () => {
    for (const tone of ["danger", "info", "warning", "success"] as const) {
      expect(normalizeAnnouncementTone(tone)).toBe(tone);
    }
  });

  it("defaults to the loud red tone for anything unrecognised", () => {
    expect(normalizeAnnouncementTone(undefined)).toBe("danger");
    expect(normalizeAnnouncementTone("")).toBe("danger");
    expect(normalizeAnnouncementTone("critical")).toBe("danger");
    expect(normalizeAnnouncementTone(42)).toBe("danger");
  });
});
