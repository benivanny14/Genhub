// =============================================================================
// GENHUB - Demo data must not reach a launched site
//
// Found live, after the demo rows were deleted from the real database: the
// homepage still showed 24 scenes with invented creators, prices and view
// counts. `/api/videos` answered `total: 0` and the page rendered a full grid
// anyway. Two separate causes, both a fallback made for "no database yet":
//
//   1. hooks/useInfiniteVideos.ts treated an EMPTY page as a failure and swapped
//      in demo data. "The query matched nothing" and "the API is unreachable"
//      are different conditions, and only the second one is a development
//      problem.
//   2. The page-level fallbacks had no environment check at all, so they fired
//      in a production build too — and a failed request left the loading
//      skeletons up forever once the fallback was removed.
//
// Both halves are asserted here, because either one alone puts fake content in
// front of a paying visitor.
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

import { demoDataEnabled } from "@/lib/demo-mode";

// -----------------------------------------------------------------------------
// 1. The gate itself
// -----------------------------------------------------------------------------

describe("the demo-data gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is closed in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(demoDataEnabled()).toBe(false);
  });

  it("is open in development and under test", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(demoDataEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "test");
    expect(demoDataEnabled()).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 2. Every consumer of demo data is gated
// -----------------------------------------------------------------------------

const SCANNED = new Set([".ts", ".tsx"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (SCANNED.has(extname(entry.name))) found.push(full.replace(/\\/g, "/"));
  }
  return found;
}

/**
 * A test file is not a surface anyone can see, and testing the demo dataset is
 * the whole point of demo-teasers.test.ts — so the rule below is about code that
 * renders, not about code that asserts.
 */
const isTestFile = (file: string) => /\.test\.tsx?$/.test(file);

/** The two legitimate guards: the shared gate, or a direct production check. */
const GATES = [/demoDataEnabled\s*\(/, /NODE_ENV\s*===\s*["']production["']/];

describe("every file that can show demo content", () => {
  it("gates it on the environment, or it would ship fake scenes", () => {
    const consumers = sourceFiles(join(process.cwd(), "src"))
      .filter((file) => !isTestFile(file))
      .filter((file) => /from\s+"@\/lib\/demo-data"/.test(readFileSync(file, "utf8")));

    // If this ever hits zero the check has stopped checking anything — the
    // import path or the file layout changed.
    expect(consumers.length).toBeGreaterThanOrEqual(4);

    const ungated = consumers.filter((file) => {
      const source = readFileSync(file, "utf8");
      return !GATES.some((gate) => gate.test(source));
    });

    expect(
      ungated,
      `these can render demo content with no environment check: ${ungated.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the seed endpoint refusing to run in production", () => {
    // The other direction of the same rule: demo data must not be writable to a
    // live database either.
    const seed = readFileSync(
      join(process.cwd(), "src", "app", "api", "demo", "seed", "route.ts"),
      "utf8"
    );
    expect(seed).toMatch(/NODE_ENV\s*===\s*"production"/);
  });
});

// -----------------------------------------------------------------------------
// 3. An empty result is never replaced
// -----------------------------------------------------------------------------

describe("the infinite-scroll hook", () => {
  const hook = readFileSync(
    join(process.cwd(), "src", "hooks", "useInfiniteVideos.ts"),
    "utf8"
  );

  it("does not consult the fallback when the API legitimately returned nothing", () => {
    // The exact shape of the bug: the fallback was chosen when page 1 came back
    // empty. Nothing in this hook may key off an empty page again.
    expect(hook).not.toMatch(/videos\.length\s*===\s*0[\s\S]{0,200}fallbackRef/);
  });

  it("still falls back when the request actually fails", () => {
    // Removing the empty-page rule must not remove the dev-without-a-database
    // path this hook exists to support.
    expect(hook).toMatch(/catch\s*\(fetchError\)[\s\S]{0,200}fallbackRef\.current/);
  });
});
