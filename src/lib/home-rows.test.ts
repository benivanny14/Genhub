// =============================================================================
// GENHUB - The home page shelves, without the repeats
//
// Why this is pinned: with one published video the home page rendered that video
// five times, under five headings, each with a "See all" leading to the same
// grid. Nothing errored — every row was correctly non-empty, which is exactly
// why no check caught it and a visitor did.
//
// The rule is that a shelf keeps only videos not already shown above it, and a
// shelf left with nothing is dropped. Order is the caller's, and the FIRST row to
// show a video is the one that keeps it.
// =============================================================================

import { describe, it, expect } from "vitest";

import { pickFreshRows } from "./home-rows";

const v = (...ids: string[]) => ids.map((id) => ({ id, title: `video ${id}` }));

describe("pickFreshRows", () => {
  it("collapses a catalogue of one to a single shelf", () => {
    const rows = pickFreshRows({
      new: v("a"),
      popular: v("a"),
      rated: v("a"),
      free: [],
      trending: v("a"),
    });

    expect(rows.new.map((x) => x.id)).toEqual(["a"]);
    // Emptied rows stay in the result as empty arrays — `RowSection` already
    // renders null for those, so the caller needs no extra branch.
    expect(rows.popular).toEqual([]);
    expect(rows.rated).toEqual([]);
    expect(rows.free).toEqual([]);
    expect(rows.trending).toEqual([]);
  });

  it("keeps the first row that shows a video, and gives the rest what is left", () => {
    const rows = pickFreshRows({
      new: v("a", "b", "c"),
      popular: v("c", "d", "a"),
      rated: v("e"),
    });

    expect(rows.new.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(rows.popular.map((x) => x.id)).toEqual(["d"]);
    expect(rows.rated.map((x) => x.id)).toEqual(["e"]);
  });

  it("leaves a real catalogue alone, so nothing changes as the site grows", () => {
    // Distinct rows: the rule must be invisible once the queries diverge.
    const rows = pickFreshRows({
      new: v("a", "b"),
      popular: v("c", "d"),
      trending: v("e"),
    });

    expect(rows.new).toHaveLength(2);
    expect(rows.popular).toHaveLength(2);
    expect(rows.trending).toHaveLength(1);
  });

  it("treats a duplicate inside one row as a repeat too", () => {
    // A duplicated join can put the same video in a row twice; the seen-set is
    // shared, so the second copy is dropped rather than rendered twice.
    const rows = pickFreshRows({ popular: v("a", "a", "b") });

    expect(rows.popular.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input or add keys", () => {
    const input = { new: v("a"), popular: v("a", "b") };
    const rows = pickFreshRows(input);

    expect(Object.keys(rows)).toEqual(["new", "popular"]);
    expect(input.popular).toHaveLength(2);
    expect(input.new).toHaveLength(1);
  });

  it("handles a missing row without throwing", () => {
    const rows = pickFreshRows({ new: undefined as unknown as { id: string }[], popular: v("a") });

    expect(rows.new).toEqual([]);
    expect(rows.popular.map((x) => x.id)).toEqual(["a"]);
  });
});
