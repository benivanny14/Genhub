// =============================================================================
// GENHUB - The build has to regenerate Prisma Client, or the deploy never runs
//
// Why this exists. Vercel caches `node_modules` between deployments and skips
// the install entirely when the lockfile has not changed. `@prisma/client`'s
// `postinstall` hook — the thing that normally runs `prisma generate` — is part
// of the install, so on a cached build it simply does not happen. The
// deployment is then compiled against whatever Prisma Client was baked into the
// cached tree.
//
// An outdated client is not a warning. It surfaces while Next.js imports every
// API route to collect page data, and it reads as a Next.js failure:
//
//   > Build error occurred
//   Error: Failed to collect page data for /api/account/become-creator
//     at /vercel/path0/.next/server/app/api/account/become-creator/route.js ...
//     {
//       clientVersion: '5.22.0',
//       errorCode: undefined
//     }
//
// The route in the message is incidental — whichever route Next imported first
// would have raised it — and the Prisma error wears a Next.js costume, so the
// log points at a page instead of at the client. Production died this way.
//
// Nothing else in this repository can see the problem. `tsc`, `npm test` and a
// local `next build` all run against a `node_modules` that was generated
// correctly on a developer machine, so removing the generate step stays green
// everywhere except the one place it matters.
//
// `prisma generate` therefore belongs in `build`: that is the single step
// Vercel always runs, whether or not it decided to install anything.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

/** The build command, split into the steps it runs in order. */
const steps: string[] = String(packageJson.scripts?.build ?? "")
  .split("&&")
  .map((step) => step.trim())
  .filter(Boolean);

const generateAt = steps.indexOf("prisma generate");
const nextBuildAt = steps.findIndex((step) => step.startsWith("next build"));

describe("the production build", () => {
  it("runs `prisma generate` itself, not only a postinstall hook", () => {
    // A postinstall-only generate is skipped whenever the hosting provider
    // reuses a cached install — which is the normal case on Vercel.
    expect(generateAt).toBeGreaterThanOrEqual(0);
  });

  it("generates the client before building the pages that import it", () => {
    expect(nextBuildAt).toBeGreaterThanOrEqual(0);
    expect(generateAt).toBeLessThan(nextBuildAt);
  });

  it("still ends in `next build`, so generating cannot replace building", () => {
    expect(steps[nextBuildAt]).toBe("next build");
    expect(steps).toHaveLength(nextBuildAt + 1);
  });

  it("can find the Prisma CLI the generate step calls", () => {
    // Vercel installs devDependencies for the build, so a devDependency is
    // enough — but the CLI has to be declared somewhere.
    const declared = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    expect(declared.prisma).toBeTruthy();
  });
});
