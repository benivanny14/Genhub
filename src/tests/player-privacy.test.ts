// =============================================================================
// GENHUB - No viewer identifier is ever drawn onto the picture
//
// The player used to print the viewer's masked phone number (or their display
// name) across the video every few seconds, as screen-record tracing. It was
// removed for two reasons, and both still hold:
//
//   * it reads as the creator's own contact details floating over a paid scene,
//     so the product looks defaced rather than produced;
//   * it never protected anything — the URL is short-lived and signed, and a
//     re-encode drops an overlay anyway.
//
// The removal is a promise to the customer, so it is pinned here rather than
// left to a comment. It is a source check on purpose: this app is bundled, and
// a bundled string is exactly the kind of thing a refactor can quietly bring
// back. `readFileSync` over source is the same technique cron-supervisor.test.ts
// uses to pin the cron routes.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const player = read("src", "components", "VideoPlayer.tsx");
const styles = read("src", "app", "globals.css");
const privacy = read("src", "app", "privacy", "page.tsx");

describe("the video player", () => {
  it("does not draw a watermark over the picture", () => {
    // The class the old overlay used. It was also the only thing keeping the
    // rule in globals.css alive, so its absence here is what lets that rule go.
    expect(player).not.toContain("watermark-overlay");
  });

  it("never prints the viewer's phone or email", () => {
    // The two fields the overlay used to show. A player that reads either one is
    // one step from rendering it, and the picture is not the place for it.
    for (const identifier of ["user?.phone", "user.phone", "user?.email", "user.email"]) {
      expect(player, `${identifier} is referenced in the player`).not.toContain(identifier);
    }
  });

  it("keeps the anti-piracy that actually works", () => {
    // Removing the overlay must not take the controls with it: signed expiring
    // URLs, the blocked right-click/drag, and the server-side access checks are
    // the parts that hold, so their wiring has to survive.
    expect(player).toContain("contextmenu");
    expect(player).toContain("dragstart");
  });
});

describe("the brand mark", () => {
  it("carries the platform's name, which is what a re-share should still say", () => {
    expect(player).toContain("Genhub");
  });

  it("is shown only at the start of a scene", () => {
    // The window is what keeps the logo out of the middle of a video somebody
    // resumed, so it is pinned rather than left to the call site.
    expect(player).toContain("BRAND_MARK_START_WINDOW_SECONDS");
    expect(player).toContain("BRAND_MARK_HOLD_MS");
    // Once per mount: seeking back to the beginning must not bring it back.
    expect(player).toContain("brandMarkShown");
  });

  it("takes no pointer events and is hidden from assistive tech", () => {
    // It sits over the picture for three seconds; a tap during that time has to
    // reach the player, and a screen reader has nothing to gain from "Genhub".
    expect(player).toContain("pointer-events-none absolute inset-0 z-10");
    expect(player).toContain('aria-hidden="true"');
  });
});

describe("the stylesheet", () => {
  it("carries no leftover watermark rule", () => {
    // Dead CSS is how a removed feature gets restored by accident: the next
    // person sees the class exists and uses it.
    expect(styles).not.toContain("watermark-overlay");
  });
});

describe("the privacy policy", () => {
  it("does not promise a watermark we no longer draw", () => {
    // It said "dynamic viewer watermarking" and "Watermarks display viewer
    // identifiers to prevent screen recording" for as long as the overlay was
    // gone — a policy describing a feature the product does not have, about the
    // one thing a customer would most want to be true.
    expect(privacy.toLowerCase()).not.toContain("watermark");
  });

  it("says what the protection actually is", () => {
    // Described in OUTCOME terms on purpose. The policy used to name the
    // mechanism ("signed for your account"); that is implementation detail, and
    // implementation detail lives on the admin reference now (see
    // src/app/admin/SystemReference.tsx). A user-facing page says what happens
    // for the customer — links are short-lived and a shared one stops working —
    // not how it is built. What is still pinned is that the claim is concrete
    // and true, not a vague reassurance.
    expect(privacy.toLowerCase()).toContain("short-lived");
    expect(privacy.toLowerCase()).toContain("stops working");
    // "We do not print your email, phone number…" — the sentence a customer is
    // owed once the tracing overlay is gone.
    expect(privacy.toLowerCase()).toContain("not print");
    expect(privacy.toLowerCase()).toContain("phone number");
  });
});
