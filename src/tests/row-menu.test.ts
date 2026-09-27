// =============================================================================
// GENHUB - The row action menu is drawn outside the card that owns the row
//
// The last row of "My Videos" opened its menu underneath the "Video
// Performance" table. Nothing was wrong with the button: the panel was
// absolutely positioned inside a `.glass-card`, every `.glass-card` carries
// `backdrop-blur`, and a backdrop filter opens a stacking context — so the
// neighbouring card painted over the menu that had spilled out of this one.
// Removing `overflow-hidden` and raising `z-index` each fixed one browser and
// left the others, and the last row is the row a creator reaches for most.
//
// The fix is structural, so the guard is a source check, like
// player-privacy.test.ts: the panel is portalled to `document.body` and
// positioned `fixed`, where no card's clipping, blur or transform can reach it.
// If someone later moves it back inside the row, this fails.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const menu = read("src", "components", "RowMenu.tsx");
const dashboard = read("src", "app", "creator", "page.tsx");

describe("the row action menu", () => {
  it("renders into document.body instead of inside the row", () => {
    expect(menu).toContain("createPortal");
    expect(menu).toContain("document.body");
  });

  it("is positioned against the viewport, not the card", () => {
    // `fixed` is the point: `absolute` is measured from the nearest positioned
    // ancestor, which is the card whose sibling was covering the menu.
    expect(menu).toContain("fixed z-40");
    expect(menu).not.toContain("absolute right-0 top-10");
  });

  it("stays one step under the modals and the header", () => {
    // The dashboard's edit dialog is z-50 and the sticky header is z-50, so the
    // menu must not be raised past them to escape the card.
    expect(menu).toContain("z-40");
    expect(menu).not.toMatch(/z-\[(?:[5-9]\d|\d{3,})\]/);
  });

  it("opens upward when the row is at the bottom of the screen", () => {
    expect(menu).toContain("flipUp");
    expect(menu).toContain("getBoundingClientRect");
  });

  it("closes on an outside press and on Escape", () => {
    expect(menu).toContain("\"mousedown\"");
    expect(menu).toContain("\"Escape\"");
  });

  it("keeps the trigger's accessible state", () => {
    expect(menu).toContain("aria-haspopup");
    expect(menu).toContain("aria-expanded");
  });

  it("is what the dashboard's My Videos rows use", () => {
    expect(dashboard).toContain("<RowMenu");
    expect(dashboard).toContain("@/components/RowMenu");
    // The old in-row panel, which is what got painted over.
    expect(dashboard).not.toContain("min-w-[180px]");
  });
});
