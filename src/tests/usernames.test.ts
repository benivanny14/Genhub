// =============================================================================
// GENHUB - The handle a signup derives from a display name
//
// Signup asks for a name and a handle, and a handle is the one name nobody else
// may take — so the field fills itself in from the display name rather than
// asking the same question twice. That shortcut has exactly one failure mode
// worth pinning: the derivation must never produce something the rules then
// refuse, or the form would greet a new account with an error about a name it
// chose for them.
//
// The product rule underneath: a person signs up as themselves, and keeps the
// handle they are given unless they want a different one.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  USERNAME_MAX_LENGTH,
  isReservedUsername,
  usernameAttempts,
  usernameFormatError,
  usernameFromDisplayName,
} from "@/lib/usernames";

describe("usernameFromDisplayName", () => {
  it("turns a display name into a handle a person would recognise", () => {
    expect(usernameFromDisplayName("Kayena glazed")).toBe("kayena_glazed");
    expect(usernameFromDisplayName("  Benny  Ivan  ")).toBe("benny_ivan");
    expect(usernameFromDisplayName("KAYENA")).toBe("kayena");
  });

  it("folds accents and replaces punctuation instead of dropping words", () => {
    expect(usernameFromDisplayName("Café Noir")).toBe("cafe_noir");
    expect(usernameFromDisplayName("Nia's Videos!")).toBe("nia_s_videos");
    expect(usernameFromDisplayName("a---b")).toBe("a_b");
  });

  it("never leaves a leading or trailing separator", () => {
    for (const name of [" Ann", "Ann ", "🎬 Ann 🎬", "---ann---"]) {
      expect(usernameFromDisplayName(name), name).toBe("ann");
    }
    // A word after the name is kept, joined by one separator: "Ann (official)"
    // must not collapse to "ann" and lose half of what the person typed.
    expect(usernameFromDisplayName("Ann (official)")).toBe("ann_official");
  });

  it("stays inside the length limit, without a separator cut off the end", () => {
    expect(usernameFromDisplayName("A".repeat(60))).toHaveLength(USERNAME_MAX_LENGTH);
    expect(usernameFromDisplayName(`${"a".repeat(29)} bc`)).toBe("a".repeat(29));
  });

  it("returns nothing when the name cannot become a handle", () => {
    // The field is then simply empty and the rules are shown beside it — better
    // than a handle nobody typed.
    for (const name of ["😍", "a", "   ", "!", "à"]) {
      expect(usernameFromDisplayName(name), name).toBe("");
    }
  });

  it("only ever derives a handle the rules accept", () => {
    for (const name of ["Kayena glazed", "Ann", "Benny Ivan 24", "Zawadi M.", "Njeri K."]) {
      const handle = usernameFromDisplayName(name);
      expect(handle, name).not.toBe("");
      expect(usernameFormatError(handle), name).toBeNull();
    }
  });

  it("numbers the handle it hands out when the name is already taken", () => {
    // The name belongs to the person, so a collision keeps the name and moves
    // the number — not the other way round.
    expect(usernameAttempts("amani").slice(0, 4)).toEqual([
      "amani",
      "amani_2",
      "amani_3",
      "amani_4",
    ]);
  });

  it("makes room for the number instead of producing the same handle twice", () => {
    // A 30-character base cannot take `_2` without giving something up, and the
    // thing it gives up must not be the number itself: every candidate has to be
    // a DIFFERENT string, or the caller would believe it had tried four names
    // when it had tried one.
    const attempts = usernameAttempts("a".repeat(USERNAME_MAX_LENGTH));

    expect(new Set(attempts).size).toBe(attempts.length);
    for (const candidate of attempts) {
      expect(candidate.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      expect(candidate).not.toMatch(/_$/);
    }
    expect(attempts[1]).toBe(`${"a".repeat(USERNAME_MAX_LENGTH - 2)}_2`);
  });

  it("can derive a reserved word, which is why the field is still validated", () => {
    // The derivation is a convenience, not a pass: "Admin" derives a name the
    // rules refuse, and the form has to say so rather than accept it.
    expect(usernameFromDisplayName("Admin")).toBe("admin");
    expect(isReservedUsername("admin")).toBe(true);
    expect(usernameFormatError("admin")).toMatch(/reserved/);
  });
});
