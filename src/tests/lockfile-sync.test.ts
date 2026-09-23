// =============================================================================
// GENHUB - The lockfile has to match package.json, or the deploy cannot install
//
// Why this exists. The deploy runs `npm ci` (vercel.json), which resolves
// nothing: it installs the lockfile and refuses to run when the two disagree.
// That refusal is deliberate — a range that resolves to one tree on a laptop and
// another in the cloud is how a build passes locally and dies during deployment
// — but it arrives as a failed deployment, minutes later, in another dashboard.
//
// It is also the one class of breakage the other gates cannot see. `tsc`, the
// suite and `next build` all run against `node_modules`, which still holds the
// OLD packages after an edit to package.json; only a fresh install notices, and
// the only fresh install in this project's life is the deploy. So an edit that
// forgets `npm install` is green everywhere except production.
//
// The first case below is a live guard on the real files: it fails the moment
// package.json and the lock go out of step, which is the point. The rest pin the
// checker's behaviour on drifted locks that are built here, because a check that
// can only ever agree is not a check.
// =============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

// One implementation, shared with the CLI and with preflight (allowJs is on, so
// TypeScript reads the .mjs directly).
import { checkLockfileSync } from "../../scripts/verify-lockfile.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));

/**
 * A drifted copy of the real lockfile. Tests mutate this rather than the shared
 * fixture, so one case can never leak into the next.
 */
function drifted(edit: (copy: any) => void) {
  const copy = structuredClone(lockfile);
  edit(copy);
  return checkLockfileSync(packageJson, copy);
}

let firstDependency: string;
let firstRange: string;
let firstVersion: string;
beforeAll(() => {
  firstDependency = Object.keys(packageJson.dependencies)[0];
  firstRange = packageJson.dependencies[firstDependency];
  firstVersion = lockfile.packages[`node_modules/${firstDependency}`].version;
});

describe("lockfile sync", () => {
  // ---------------------------------------------------------------------------
  // 1. The real files — a live guard, not a fixture
  // ---------------------------------------------------------------------------
  it("accepts the package.json and lockfile actually in the repository", () => {
    const report = checkLockfileSync(packageJson, lockfile);

    expect(report.errors).toEqual([]);
    expect(report.checked).toBe(
      Object.keys(packageJson.dependencies).length +
        Object.keys(packageJson.devDependencies).length
    );
  });

  // ---------------------------------------------------------------------------
  // 2. A dependency declared but never installed
  // ---------------------------------------------------------------------------
  it("catches a dependency added to package.json without running npm install", () => {
    const report = drifted(() => {}); // sanity: unchanged copy is clean
    expect(report.errors).toEqual([]);

    const added = checkLockfileSync(
      { ...packageJson, dependencies: { ...packageJson.dependencies, "left-pad": "^1.3.0" } },
      lockfile
    );
    expect(added.errors.join("\n")).toContain('"left-pad" is declared in package.json but missing');
    expect(added.errors.join("\n")).toContain("npm install");
  });

  // ---------------------------------------------------------------------------
  // 3. The same package, a different range — the drift that caused a real
  //    deployment failure (@types/node ^20.14.0 against a vitest peer)
  // ---------------------------------------------------------------------------
  it("catches a range edited in package.json only", () => {
    const report = checkLockfileSync(
      { ...packageJson, dependencies: { ...packageJson.dependencies, [firstDependency]: "^999.0.0" } },
      lockfile
    );

    expect(report.errors.join("\n")).toContain(`"${firstDependency}" is "^999.0.0" in package.json`);
    expect(report.errors.join("\n")).toContain(`but "${firstRange}" in the lockfile`);
  });

  // ---------------------------------------------------------------------------
  // 4. Removed from package.json, left behind in the lock
  // ---------------------------------------------------------------------------
  it("catches a dependency removed from package.json but still in the lockfile", () => {
    const { [firstDependency]: _removed, ...rest } = packageJson.dependencies;
    const report = checkLockfileSync({ ...packageJson, dependencies: rest }, lockfile);

    expect(report.errors.join("\n")).toContain(`"${firstDependency}" is in the lockfile but no longer`);
  });

  // ---------------------------------------------------------------------------
  // 5. Ranges agree, the locked version does not — a hand-edited or badly
  //    merged lock. Range comparison alone cannot see this one, which is why
  //    the checker reads real semver instead of string-comparing.
  // ---------------------------------------------------------------------------
  it("catches a locked version that satisfies nothing", () => {
    const report = drifted((copy) => {
      copy.packages[`node_modules/${firstDependency}`].version = "0.0.1";
    });

    expect(report.errors.join("\n")).toContain(
      `${firstDependency}" is locked at 0.0.1, which does not satisfy "${firstRange}"`
    );
  });

  it("still accepts the version the lockfile resolved, and knows its range", () => {
    // Guards the opposite failure: a checker that rejects everything would pass
    // the test above for the wrong reason.
    expect(firstVersion).toBeTruthy();
    const report = checkLockfileSync(packageJson, lockfile);
    expect(report.errors).toEqual([]);
    expect(firstRange.startsWith("^")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 6. Declared and ranged correctly, but nothing to install from
  // ---------------------------------------------------------------------------
  it("catches a missing resolved entry", () => {
    const report = drifted((copy) => {
      delete copy.packages[`node_modules/${firstDependency}`];
    });

    expect(report.errors.join("\n")).toContain(
      `"${firstDependency}" has no resolved entry in the lockfile`
    );
  });

  // ---------------------------------------------------------------------------
  // 7. A lock from an npm too old for `npm ci`
  // ---------------------------------------------------------------------------
  it("catches a lockfile that npm ci cannot consume", () => {
    const report = drifted((copy) => {
      copy.lockfileVersion = 1;
    });

    expect(report.errors.join("\n")).toContain("lockfileVersion 1");
  });

  it("catches a lockfile with no root entry at all", () => {
    const report = drifted((copy) => {
      delete copy.packages[""];
    });

    expect(report.errors.join("\n")).toContain("no root entry");
  });

  // ---------------------------------------------------------------------------
  // 8. Nothing that is not a semver range may fail the gate — `file:`, `link:`
  //    and git dependencies are installed by npm without a version to compare,
  //    and blocking a launch on one would be a false alarm.
  // ---------------------------------------------------------------------------
  it("skips a non-semver range with a warning instead of failing", () => {
    const report = checkLockfileSync(
      { ...packageJson, dependencies: { ...packageJson.dependencies, "local-pkg": "file:../local-pkg" } },
      {
        ...lockfile,
        packages: {
          ...lockfile.packages,
          "": {
            ...lockfile.packages[""],
            dependencies: {
              ...lockfile.packages[""].dependencies,
              "local-pkg": "file:../local-pkg",
            },
          },
          "node_modules/local-pkg": { version: "1.0.0", link: true },
        },
      }
    );

    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toContain("not a semver range");
  });
});
