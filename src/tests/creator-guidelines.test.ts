// =============================================================================
// GENHUB - The rules a creator reads before uploading
//
// These are not decoration: two of them carry a stated consequence (a ban with
// the earned money held, and a video that will not publish), and the upload
// gate does not let a creator past until every one of them is ticked. The
// failure this file guards against is a rule that quietly disappears — a list
// edited in one place, an id reused so a tick lands on the wrong line, or a
// version that does not move when the rules do, which would mean creators are
// never shown the change at all.
//
// Bilingual on purpose: the audience reads Kiswahili first, and an English-only
// gate is one a creator clicks past without reading.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  CREATOR_GUIDELINES,
  CREATOR_GUIDELINES_VERSION,
  CREATOR_MIN_WITHDRAWAL_TZS,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
  MIN_VIDEO_DURATION_SECONDS,
} from "@/lib/creator-guidelines";

describe("creator guidelines", () => {
  it("has a unique id for every rule, because the id is the receipt", () => {
    const ids = CREATOR_GUIDELINES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states every rule in both languages", () => {
    for (const rule of CREATOR_GUIDELINES) {
      expect(rule.sw.trim().length).toBeGreaterThan(0);
      expect(rule.en.trim().length).toBeGreaterThan(0);
    }
  });

  it("requires the creator's face, the 8-minute floor, a clean set and proper light", () => {
    const ids = CREATOR_GUIDELINES.map((rule) => rule.id);
    expect(ids).toContain("face");
    expect(ids).toContain("duration");
    expect(ids).toContain("clean-set");
    expect(ids).toContain("lighting");
  });

  it("marks the rules that carry a consequence as severe", () => {
    const severe = CREATOR_GUIDELINES.filter((rule) => rule.severe).map((rule) => rule.id);
    // A video that hides the creator's face, runs short, or is visibly dirty is
    // refused — and the creator is told that before uploading it.
    expect(severe).toEqual(expect.arrayContaining(["face", "duration", "clean-set"]));
  });

  it("spells out the numbers a creator is held to, from the constants the server enforces", () => {
    const duration = CREATOR_GUIDELINES.find((rule) => rule.id === "duration");
    const withdrawal = CREATOR_GUIDELINES.find((rule) => rule.id === "withdrawal");

    expect(duration?.sw).toContain(String(MIN_VIDEO_DURATION_SECONDS));
    expect(withdrawal?.sw).toContain(CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString());
  });

  it("asks for the same acknowledgement in both languages", () => {
    expect(GUIDELINE_ACK_LABEL_SW.trim().length).toBeGreaterThan(0);
    expect(GUIDELINE_ACK_LABEL_EN.trim().length).toBeGreaterThan(0);
  });

  it("keeps the acknowledgement version ahead of the first one", () => {
    // A creator's acknowledgement is stored against this number. If a rule is
    // added or changed without bumping it, every existing creator keeps the
    // "accepted" state they gave to a list that no longer exists — which is the
    // one way this gate can silently stop being a gate. The clean-set and
    // lighting rules are the second version, so this must be at least 2.
    expect(CREATOR_GUIDELINES_VERSION).toBeGreaterThanOrEqual(2);
  });
});
