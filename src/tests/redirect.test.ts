// =============================================================================
// GENHUB - ?redirect= is a path on this site, or nothing
//
// The middleware writes this value (`/login?redirect=/admin`) and the login form
// reads it, so it is attacker-reachable in the ordinary way: a link somebody else
// composes. Every case below is a way a "just use the parameter" implementation
// becomes an open redirect — a login page on our domain that delivers the visitor
// to somebody else's site with our name still in the address bar when they type
// their password.
// =============================================================================

import { describe, it, expect } from "vitest";

import { safeInAppPath } from "@/lib/redirect";

describe("safeInAppPath", () => {
  it("keeps the paths the middleware actually writes", () => {
    for (const path of ["/admin", "/wallet", "/feed", "/creator/analytics"]) {
      expect(safeInAppPath(path), path).toBe(path);
    }
  });

  it("keeps a path with its query string", () => {
    expect(safeInAppPath("/admin?tab=payments")).toBe("/admin?tab=payments");
  });

  it.each([
    "https://evil.example/login",
    "http://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.example",
    "admin",
    "",
    "   ",
  ])("refuses %s", (value) => {
    expect(safeInAppPath(value)).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(safeInAppPath(null)).toBeNull();
    expect(safeInAppPath(undefined)).toBeNull();
  });

  it("refuses a control character smuggled into a path", () => {
    // Header-splitting literals read as a path to `startsWith("/")`.
    expect(safeInAppPath("/admin\r\nSet-Cookie: x=1")).toBeNull();
  });

  it("trims before deciding, so a padded path still works", () => {
    expect(safeInAppPath("  /admin  ")).toBe("/admin");
    expect(safeInAppPath("  //evil.example  ")).toBeNull();
  });
});
