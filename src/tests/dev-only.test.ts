// =============================================================================
// GENHUB - Three endpoints that may only exist on somebody's machine
//
// /api/auth/demo-login mints sessions (including ADMIN), /api/dev/sandbox/complete
// marks an order paid without money moving, and /api/demo/seed invents a
// catalogue. Each was guarded by NODE_ENV alone, so one unset variable on a
// self-hosted deployment switched all three on at a public URL.
//
// The guard is now two conditions: not production AND reachable only at a
// localhost URL. These tests pin the URL rule (including the hostname that looks
// like loopback and is not) and the fact that the routes use the shared guard.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLocalAppUrl } from "@/lib/dev-only";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const DEV_ONLY_ROUTES = [
  ["src", "app", "api", "auth", "demo-login", "route.ts"],
  ["src", "app", "api", "dev", "sandbox", "complete", "route.ts"],
  ["src", "app", "api", "demo", "seed", "route.ts"],
];

describe("isLocalAppUrl", () => {
  it("accepts the URLs a laptop actually uses", () => {
    expect(isLocalAppUrl("http://localhost:3000")).toBe(true);
    expect(isLocalAppUrl("http://localhost")).toBe(true);
    expect(isLocalAppUrl("http://127.0.0.1:4321")).toBe(true);
    expect(isLocalAppUrl("http://[::1]:3000/")).toBe(true);
  });

  it("refuses anything with a real hostname", () => {
    expect(isLocalAppUrl("https://genhub.co.tz")).toBe(false);
    expect(isLocalAppUrl("https://genhub-git-main-user.vercel.app")).toBe(false);
    // A domain that merely STARTS with the word is not loopback — the pattern is
    // anchored, so this cannot be used to look local.
    expect(isLocalAppUrl("http://localhost.attacker.example")).toBe(false);
    expect(isLocalAppUrl("http://127.0.0.1.attacker.example:3000")).toBe(false);
    // `https://localhost:3000` IS loopback — a laptop running the dev server
    // behind a local proxy is still a laptop. What is refused is a real domain,
    // not the scheme.
    expect(isLocalAppUrl("https://localhost:3000")).toBe(true);
  });
});

describe("the development-only routes", () => {
  it("ask the shared guard instead of trusting NODE_ENV alone", () => {
    for (const parts of DEV_ONLY_ROUTES) {
      const source = read(...parts);
      expect(source, parts.join("/")).toContain("developmentOnlyEnabled()");
      expect(source, parts.join("/")).not.toContain('process.env.NODE_ENV === "production"');
    }
  });

  it("keep the gateway condition on the sandbox checkout", () => {
    // The location check is added to the existing one, not instead of it: a
    // sandbox payment route must also be a deployment that is not charging real
    // money.
    const source = read("src", "app", "api", "dev", "sandbox", "complete", "route.ts");
    expect(source).toContain("developmentOnlyEnabled() &&");
    expect(source).toContain("config.harakaPay.sandbox");
  });
});

describe("the cron guard", () => {
  it("asks the same question through the same helper", () => {
    const source = read("src", "lib", "cron-auth.ts");
    expect(source).toContain('from "./dev-only"');
    expect(source).toContain("isLocalAppUrl()");
  });
});
