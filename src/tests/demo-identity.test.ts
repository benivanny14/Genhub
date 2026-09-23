// =============================================================================
// GENHUB - The rule that decides what is demo content
//
// scripts/demo-wipe.mjs deletes rows based on this predicate, so the predicate
// is the part that has to be right. Both directions are a real bug:
//
//   too narrow  -> demo videos survive and keep showing on a live homepage, and
//                  the wipe reports success
//   too wide    -> a real creator's account matches, and the wipe deletes it
//
// So the cases below are mostly about the boundary: ids and domains that look
// like demo content without being it.
// =============================================================================

import { describe, it, expect } from "vitest";

// The script and the test share one implementation rather than a copy, so they
// cannot drift apart. allowJs is on, so TypeScript reads the .mjs directly.
import {
  isDemoId,
  isDemoEmail,
  isDemoAccount,
  demoReason,
  WIPE_ORDER,
  DEMO_EMAIL_DOMAIN,
} from "../../scripts/_demo-identity.mjs";

describe("what counts as demo content", () => {
  it("recognises the ids the seed writes", () => {
    // Every shape POST /api/demo/seed actually creates.
    for (const id of [
      "demo-1",
      "demo-24",
      "demo-creator-1",
      "demo-viewer-1",
      "demo-admin-1",
      "demo-cmt-1",
      "demo-coupon-3",
      "demo-post-2",
      "demo-sub-1",
      "demo-acc-1",
      "demo-notif-1",
      "demo-tx-01",
      "demo-tx-investigation",
    ]) {
      expect(isDemoId(id), `${id} should be demo`).toBe(true);
    }
  });

  it("does not swallow a real id that merely starts with the letters", () => {
    // The trap is a missing hyphen. "demolition-1" begins with "demo" and would
    // match a naive startsWith("demo") — and the id space is not ours to assume.
    for (const id of [
      "demolition-1",
      "demo",
      "demo2",
      "clx8f2k9a0000abcd1234efgh", // cuid() — what Prisma generates
      "creator-1",
      "",
    ]) {
      expect(isDemoId(id), `${id} must not be demo`).toBe(false);
    }
  });

  it("does not classify a non-string as demo", () => {
    // Columns are nullable; a null id must never be read as demo content,
    // because "delete where isDemoId(id)" must not match absent values.
    for (const value of [null, undefined, 42, {}, []]) {
      expect(isDemoId(value as unknown as string)).toBe(false);
      expect(isDemoEmail(value as unknown as string)).toBe(false);
      expect(isDemoAccount(value as unknown as { id: string })).toBe(false);
    }
  });

  it("recognises the seeded account emails, case-insensitively", () => {
    expect(isDemoEmail("viewer@demo.genhub.local")).toBe(true);
    expect(isDemoEmail("admin@demo.genhub.local")).toBe(true);
    expect(isDemoEmail("demo-creator-3@demo.genhub.local")).toBe(true);
    // Addresses are case-insensitive in practice, and the seed lowercases
    // nothing — an account created by hand could differ in case.
    expect(isDemoEmail("VIEWER@DEMO.GENHUB.LOCAL")).toBe(true);
  });

  it("does not classify a real address that contains the domain text", () => {
    // The boundary cases. `demo@` at a real domain is a person; the domain has
    // to follow an `@` to count.
    for (const email of [
      "demo@genhub.co.tz",
      "demo@genhub.local",
      "someone@notdemo.genhub.local",
      "someone@sub.demo.genhub.local",
      "someone@demo.genhub.local.example.com",
      "demo.genhub.local",
      "viewer@demo.genhub.local.evil.com",
      "",
    ]) {
      expect(isDemoEmail(email), `${email} must not be demo`).toBe(false);
    }
  });

  it("accepts an account as demo when either signal says so", () => {
    // The seed's fixed accounts are identified by id; a hand-created one by
    // email. Either alone is enough, and the wipe uses this, not one of them.
    expect(isDemoAccount({ id: "demo-viewer-1", email: "viewer@demo.genhub.local" })).toBe(true);
    expect(isDemoAccount({ id: "demo-admin-1", email: null })).toBe(true);
    expect(isDemoAccount({ id: "clx123", email: "x@demo.genhub.local" })).toBe(true);
    expect(isDemoAccount({ id: "clx123", email: "real@genhub.co.tz" })).toBe(false);
    expect(isDemoAccount(null)).toBe(false);
  });

  it("explains why a row was classified as demo", () => {
    // Reports are read by a person deciding whether to trust the list, so the
    // reason travels with the row instead of being implied.
    expect(demoReason({ id: "clx1", email: "x@demo.genhub.local" })).toContain(
      DEMO_EMAIL_DOMAIN
    );
    expect(demoReason({ id: "demo-5", email: null })).toContain("demo-");
    expect(demoReason({ id: "clx1", email: "real@genhub.co.tz" })).toBeNull();
    expect(demoReason(null)).toBeNull();
  });
});

describe("the wipe order", () => {
  const at = (table: string) => {
    const index = WIPE_ORDER.indexOf(table);
    expect(index, `${table} is missing from WIPE_ORDER`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("deletes the rows that block a user or video before the parent", () => {
    // These four declare no `onDelete: Cascade`, so the database refuses to
    // delete a user or video that still references one. Getting the order wrong
    // is a runtime failure mid-wipe, which leaves the database half-cleared.
    for (const child of ["transaction", "payMessage", "payoutRequest", "videoReport"]) {
      expect(at(child), `${child} must be deleted before user`).toBeLessThan(at("user"));
      expect(at(child), `${child} must be deleted before video`).toBeLessThan(at("video"));
    }
  });

  it("deletes every child of a video before the video", () => {
    for (const child of ["galleryImage", "watchProgress", "comment", "videoAccess", "videoLike", "favorite"]) {
      expect(at(child), `${child} must be deleted before video`).toBeLessThan(at("video"));
    }
  });

  it("deletes the user last, so nothing is orphaned on the way", () => {
    expect(at("user")).toBe(WIPE_ORDER.length - 1);
  });

  it("does not name the same table twice", () => {
    expect(new Set(WIPE_ORDER).size).toBe(WIPE_ORDER.length);
  });
});
