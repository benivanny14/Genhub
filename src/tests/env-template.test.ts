// =============================================================================
// GENHUB - The environment template has to describe every knob the code reads
//
// Why this exists. `lib/redis.ts` reads REDIS_URL *and* the Upstash REST pair,
// and the REST pair wins whenever both are set. `.env.example` mentioned only
// REDIS_URL — so a host got configured with `redis://localhost:6379` and no
// Upstash credentials at all, and rate limiting quietly fell back to
// per-instance memory. Nothing failed. The code was right, the config audit
// already warned about that exact state, and the person filling in the host's
// settings had no way to know the two keys existed: the template is the only
// list anyone is given.
//
// That is a documentation bug with a production consequence, and this test is
// the guard. A key the app reads either appears in `.env.example` (commented is
// fine — it still tells the reader it exists) or is named below as something the
// hosting platform supplies, where documenting it would be wrong.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * Supplied by the platform or by a local script, never by the person deploying.
 * Documenting these in .env.example would invite someone to set them by hand —
 * `NODE_ENV=production` in a template is a real way to break a dev machine.
 */
const SUPPLIED_BY_PLATFORM = new Set([
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "RAILWAY_ENVIRONMENT",
  "RENDER",
  // scripts/launch-check.mjs: GitHub points this at a markdown file for the
  // run's own page. Documenting it would invite someone to set it by hand,
  // where it does nothing.
  "GITHUB_STEP_SUMMARY",
  "SETUP_NO_OPEN", // scripts/setup-env.mjs: skips opening the browser
]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);

/** Every file under `dir` whose extension we read, skipping build output. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (SCANNED_EXTENSIONS.has(extname(entry.name))) found.push(full);
  }
  return found;
}

/**
 * Source with comments removed before scanning.
 *
 * Without this the guard reads prose: documenting the pattern `process.env.KEY`
 * in a comment — as the function below does — registers "KEY" as a variable the
 * application needs, and the failure is nonsense.
 *
 * Only comments are dropped, never a line's code, so this cannot hide a real
 * read and silently weaken the check; a comment mentioning a key at the end of
 * a line of code is still seen, which fails loudly rather than passing.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

/** Keys read as `process.env.KEY` or `process.env["KEY"]` in one file. */
function keysReadIn(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const keys: string[] = [];
  // Plain exec loop rather than matchAll: this project compiles to a target
  // where iterating a RegExpStringIterator needs --downlevelIteration.
  const pattern = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\["([A-Z_][A-Z0-9_]*)"\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    keys.push(match[1] ?? match[2]);
  }
  return keys;
}

/** Keys the template names, commented or not. */
function keysDocumented(): Set<string> {
  const source = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const keys = new Set<string>();
  const pattern = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) keys.add(match[1]);
  return keys;
}

describe("environment template", () => {
  it("documents every variable the application reads", () => {
    const documented = keysDocumented();

    const read = new Set<string>();
    for (const dir of ["src", "scripts"]) {
      for (const file of sourceFiles(join(process.cwd(), dir))) {
        for (const key of keysReadIn(file)) read.add(key);
      }
    }
    // The datasource URL lives in the Prisma schema, not in TypeScript.
    for (const key of keysReadIn(join(process.cwd(), "prisma", "schema.prisma"))) {
      read.add(key);
    }

    const undocumented = Array.from(read)
      .filter((key) => !SUPPLIED_BY_PLATFORM.has(key) && !documented.has(key))
      .sort();

    // The message names the keys, so a failure says what to add rather than
    // just that the counts differ.
    expect(undocumented, `add these to .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("names both Redis options, since only one of them survives serverless", () => {
    // The specific pair that went missing. Both are read by lib/redis.ts and the
    // REST pair wins, so a template that shows only REDIS_URL produces a host
    // configured with a localhost address and no working cache.
    const documented = keysDocumented();

    expect(documented.has("REDIS_URL")).toBe(true);
    expect(documented.has("UPSTASH_REDIS_REST_URL")).toBe(true);
    expect(documented.has("UPSTASH_REDIS_REST_TOKEN")).toBe(true);
  });

  it("does not name a variable that nothing reads", () => {
    // The other direction, and the cheaper mistake to make: a template full of
    // keys that do nothing teaches people to set variables at random.
    const documented = keysDocumented();

    const read = new Set<string>();
    for (const dir of ["src", "scripts"]) {
      for (const file of sourceFiles(join(process.cwd(), dir))) {
        for (const key of keysReadIn(file)) read.add(key);
      }
    }
    for (const key of keysReadIn(join(process.cwd(), "prisma", "schema.prisma"))) {
      read.add(key);
    }

    // TEST_DATABASE_URL / ALLOW_TESTS_ON_EXTERNAL_DB are read by src/tests, so
    // they are already in `read`; nothing needs an exception here.
    const orphans = Array.from(documented).filter((key) => !read.has(key)).sort();

    expect(orphans, `these do nothing, remove them: ${orphans.join(", ")}`).toEqual([]);
  });
});
