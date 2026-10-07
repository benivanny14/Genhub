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
  CREATOR_REVENUE_SHARE_PERCENT,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
  MIN_VIDEO_DURATION_SECONDS,
  needsGuidelineAcceptance,
} from "@/lib/creator-guidelines";
import config from "@/lib/config";

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

  it("asks the creator for a visible face, a clean set and proper light", () => {
    const ids = CREATOR_GUIDELINES.map((rule) => rule.id);
    expect(ids).toContain("face");
    expect(ids).toContain("duration");
    expect(ids).toContain("clean-set");
    expect(ids).toContain("lighting");
  });

  it("marks the rules that carry a consequence as severe", () => {
    const severe = CREATOR_GUIDELINES.filter((rule) => rule.severe).map((rule) => rule.id);
    // A video that hides the creator's face or is visibly dirty is refused — and
    // the creator is told that before uploading it.
    expect(severe).toEqual(expect.arrayContaining(["face", "clean-set"]));
  });

  it("keeps the length a recommendation rather than a refusal", () => {
    // The length rule used to be enforced on the upload page AND in the encoding
    // lifecycle, so a shorter scene was refused before it was sent and taken down
    // after it was published. Both gates are gone; what must remain is the ADVICE,
    // or creators lose the one place that explains what performs here.
    const duration = CREATOR_GUIDELINES.find((rule) => rule.id === "duration");

    expect(duration?.severe).toBeFalsy();
    expect(duration?.en).toMatch(/recommended/i);
    expect(duration?.en).toMatch(/allowed/i);
    expect(duration?.sw).toMatch(/inashauriwa/i);
  });

  it("spells out the numbers a creator is held to, from the shared constants", () => {
    const duration = CREATOR_GUIDELINES.find((rule) => rule.id === "duration");
    const withdrawal = CREATOR_GUIDELINES.find((rule) => rule.id === "withdrawal");

    expect(duration?.sw).toContain(String(MIN_VIDEO_DURATION_SECONDS));
    expect(withdrawal?.sw).toContain(CREATOR_MIN_WITHDRAWAL_TZS.toLocaleString());
  });

  it("quotes the same revenue share the settlement actually pays", () => {
    // 70% is the platform's public promise, and it is quoted as text on the
    // dashboard. The number that decides what a creator is PAID lives in config
    // and is applied by splitRevenue(); if those two ever disagree, the screen
    // is promising something the ledger does not do.
    expect(CREATOR_REVENUE_SHARE_PERCENT).toBe(config.business.creatorFeePercent);
    // ...and the two halves are a whole, so neither side can be moved alone.
    expect(CREATOR_REVENUE_SHARE_PERCENT + config.business.platformFeePercent).toBe(100);
  });

  it("asks for the same acknowledgement in both languages", () => {
    expect(GUIDELINE_ACK_LABEL_SW.trim().length).toBeGreaterThan(0);
    expect(GUIDELINE_ACK_LABEL_EN.trim().length).toBeGreaterThan(0);
  });

  it("asks again when the account has never accepted any version", () => {
    expect(needsGuidelineAcceptance(0)).toBe(true);
    expect(needsGuidelineAcceptance(null)).toBe(true);
    expect(needsGuidelineAcceptance(undefined)).toBe(true);
  });

  it("does not ask again once the current version is accepted", () => {
    expect(needsGuidelineAcceptance(CREATOR_GUIDELINES_VERSION)).toBe(false);
  });

  it("asks again when the accepted version is older than the current rules", () => {
    // The exact failure this guards against: a receipt from a previous wording
    // must not count as consent to the new one. This is what makes bumping the
    // version actually show creators the change.
    expect(needsGuidelineAcceptance(CREATOR_GUIDELINES_VERSION - 1)).toBe(true);
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
