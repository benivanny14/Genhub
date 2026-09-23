#!/usr/bin/env node
// =============================================================================
// GENHUB - Lockfile sync check
//
// Run:  node scripts/verify-lockfile.mjs     (or: npm run verify:lockfile)
//
// The deploy installs with `npm ci` (see vercel.json), which does not resolve
// anything: it installs the lockfile and refuses to run when package.json and
// package-lock.json disagree. That refusal is the point — a range that resolves
// to one tree on a laptop and another in the cloud is how a build passes locally
// and dies during deployment — but it arrives as a failed deployment, minutes
// later, in another dashboard. This turns it into one line of local output.
//
// `npm ci` compares exactly three things, so this checks the same three:
//
//   1. every declared dependency appears in the lock's root entry, with the
//      identical range string (a range edited in package.json alone);
//   2. nothing is left in the lock that package.json no longer declares;
//   3. each declared dependency has a resolved entry, and the locked version
//      actually satisfies the declared range (a hand-edited or badly merged
//      lock can satisfy 1 and 2 while breaking this one).
//
// Check 3 needs real semver semantics — `^8.3.0` is not a string comparison —
// so `semver` is a declared devDependency rather than a borrow from whatever
// happens to be hoisted today. A check that quietly loses its teeth when
// hoisting changes is worse than no check.
// =============================================================================

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

let semver = null;
try {
  // createRequire, not a top-level await import: this module is loaded by the
  // CLI, by preflight and by the tests, and none of them should have to care
  // about resolving an ESM import at module-evaluation time.
  semver = createRequire(import.meta.url)("semver");
} catch {
  // Not installed (fresh clone, no `npm install` yet). Check 3 is skipped and
  // says so rather than passing silently.
  semver = null;
}

/**
 * Compare a manifest against a lockfile the way `npm ci` does.
 *
 * Pure — it takes parsed JSON, so the tests can feed it drifted locks without
 * touching the real ones.
 *
 * @param {Record<string, any>} packageJson parsed package.json
 * @param {Record<string, any>} lockfile    parsed package-lock.json
 * @returns {{ errors: string[], warnings: string[], checked: number }}
 */
export function checkLockfileSync(packageJson, lockfile) {
  const errors = [];
  const warnings = [];
  let checked = 0;

  const root = lockfile?.packages?.[""];
  if (!root) {
    errors.push(
      'package-lock.json has no root entry (packages[""]) — it was written by an npm too old to describe the tree, or hand-edited. Run: npm install'
    );
    return { errors, warnings, checked };
  }

  const version = Number(lockfile.lockfileVersion);
  if (!(version >= 2)) {
    errors.push(
      `package-lock.json is lockfileVersion ${lockfile.lockfileVersion || "(missing)"} — npm ci needs 2 or 3. Run: npm install`
    );
  }

  for (const section of SECTIONS) {
    const declared = packageJson[section] || {};
    const locked = root[section] || {};

    for (const [name, range] of Object.entries(declared)) {
      checked++;
      if (!(name in locked)) {
        errors.push(
          `${section}: "${name}" is declared in package.json but missing from the lockfile. Run: npm install`
        );
        continue;
      }
      if (locked[name] !== range) {
        errors.push(
          `${section}: "${name}" is "${range}" in package.json but "${locked[name]}" in the lockfile. Run: npm install and commit the lockfile`
        );
        continue;
      }

      const entry = lockfile.packages?.[`node_modules/${name}`];
      if (!entry || !entry.version) {
        errors.push(
          `${section}: "${name}" has no resolved entry in the lockfile (node_modules/${name}). Run: npm install`
        );
        continue;
      }

      // `file:`, `link:`, `git+…` and aliases are not semver ranges, and npm
      // handles them without a version to compare. Say so instead of skipping
      // in silence.
      if (!semver) {
        warnings.push(
          `could not verify that ${name}@${entry.version} satisfies "${range}" — semver is not installed (run: npm install)`
        );
        continue;
      }
      if (!semver.validRange(range)) {
        warnings.push(
          `${section}: "${name}" is "${range}", which is not a semver range — skipped the version check`
        );
        continue;
      }
      if (!semver.satisfies(entry.version, range, { includePrerelease: true })) {
        errors.push(
          `${section}: "${name}" is locked at ${entry.version}, which does not satisfy "${range}". Run: npm install`
        );
      }
    }

    for (const name of Object.keys(locked)) {
      if (!(name in declared)) {
        errors.push(
          `${section}: "${name}" is in the lockfile but no longer in package.json. Run: npm install and commit the lockfile`
        );
      }
    }
  }

  return { errors, warnings, checked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Only print a report when this file IS the entry point, not when preflight or
// a test imports the checker.
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  console.log("\n=== GENHUB lockfile check ===\n");

  let report;
  try {
    report = checkLockfileSync(
      JSON.parse(readFileSync("package.json", "utf8")),
      JSON.parse(readFileSync("package-lock.json", "utf8"))
    );
  } catch (error) {
    console.log(`  \u2717 could not read package.json / package-lock.json: ${error.message}`);
    console.log("    Run this from the project root.\n");
    process.exit(1);
  }

  for (const warning of report.warnings) console.log(`  ! ${warning}`);

  if (report.errors.length === 0) {
    console.log(
      `  \u2713 package.json and package-lock.json agree on ${report.checked} direct dependencies (ranges and locked versions)\n`
    );
    console.log("=== PASS ===\n");
    process.exit(0);
  }

  console.log(
    `  \u2717 package.json and package-lock.json disagree — \`npm ci\` would refuse to install:\n`
  );
  for (const error of report.errors) console.log(`      ${error}`);
  console.log("\n=== FAIL ===\n");
  process.exit(1);
}
