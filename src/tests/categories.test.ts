import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  CATEGORY_IDS,
  getCategory,
  categoryHref,
  categoryFilter,
} from "@/lib/categories";

describe("category registry", () => {
  it("keeps the \"all\" pseudo-category first", () => {
    expect(CATEGORIES[0].id).toBe("all");
  });

  it("uses unique ids", () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses URL-safe slugs (lowercase letters, digits and dashes)", () => {
    for (const { id } of CATEGORIES) {
      expect(id, `bad slug: ${id}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("gives every category a label, a description and an image seed", () => {
    for (const c of CATEGORIES) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.description.trim().length).toBeGreaterThan(0);
      expect(c.imageSeed.length).toBeGreaterThan(0);
    }
  });

  it("carries the full new genre catalogue (>= 55 real categories)", () => {
    // 55 real genres + the "all" pseudo-category.
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(56);
  });

  it("looks up a category by id", () => {
    expect(getCategory("lesbian")?.label).toBe("Lesbian");
    expect(getCategory("nope")).toBeUndefined();
  });

  it("builds browse and filter helpers correctly", () => {
    expect(categoryHref("all")).toBe("/browse/all");
    expect(categoryHref("anal")).toBe("/browse/anal");
    expect(categoryHref("")).toBe("/browse/all");

    // The API treats "all" and "" as "no filter".
    expect(categoryFilter("all")).toBe("");
    expect(categoryFilter("")).toBe("");
    expect(categoryFilter("anal")).toBe("anal");
  });

  it("exposes CATEGORY_IDS in registry order", () => {
    expect(CATEGORY_IDS).toEqual(CATEGORIES.map((c) => c.id));
  });
});
