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

// The other half of the same failure. `prisma generate` runs on the build
// image, but the client it writes is loaded on the runtime — and a query engine
// is a native binary. Generating with no `binaryTargets` fetches only the
// engine for the machine doing the generating, so the deployment gets a client
// whose engine cannot be dlopen'd there:
//
//   PrismaClientInitializationError: Unable to require(`/vercel/path0/.../libquery_engine.so.node`).
//   Prisma engines do not seem to be compatible with your system
//     clientVersion: '5.22.0',
//     errorCode: undefined
//
// That is the same clientVersion-and-no-errorCode shape as a stale client, which
// is why both fixes are pinned here: the generate step and the engines it
// produces. Losing this list is silent locally (the local engine is still one of
// them) and fatal only on the deploy.
const schema = readFileSync("prisma/schema.prisma", "utf8");

/** The `generator client { ... }` block, so a target elsewhere cannot pass this. */
const generatorBlock =
  schema.match(/generator\s+client\s*\{([\s\S]*?)\}/)?.[1] ?? "";

const binaryTargets = (
  generatorBlock.match(/binaryTargets\s*=\s*\[([^\]]*)\]/)?.[1] ?? ""
)
  .split(",")
  .map((target) => target.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

describe("the generated client", () => {
  it("declares the query engines it may be generated on", () => {
    expect(binaryTargets, "no binaryTargets in generator client").not.toHaveLength(0);
  });

  it("carries the engine for the Linux runtime it is deployed to", () => {
    // Vercel builds and runs on Amazon Linux with OpenSSL 3.0.x. Without this
    // exact string the client generated during the build has no engine the
    // runtime can load, and the failure lands at build/collect-page-data time
    // with a Prisma error attributed to whichever page imported the client.
    expect(binaryTargets).toContain("rhel-openssl-3.0.x");
  });

  it("still carries `native`, so a local generate stays usable", () => {
    // Dropping `native` in favour of the deploy target would trade a red deploy
    // for a broken `npm test` and `npm run dev` on every developer's machine.
    expect(binaryTargets).toContain("native");
  });
});
