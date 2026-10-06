// =============================================================================
// GENHUB - No retired-gateway remnants (guard test)
//
// SonicPesa is the only gateway. AzamPay, Selcom and ClickPesa were integrated
// and then deliberately removed. src/tests/gateway-guard.test.ts already keeps a
// *source identifier* from creeping back in. This suite closes the two gaps that
// guard leaves open:
//
//   1. a file or directory NAMED after a retired gateway (a route folder, an
//      integration module) — the identifier scan only reads file *contents*;
//   2. a retired gateway's variables in any environment file — those are not
//      shipped source, so no source scan would ever see them.
//
// It walks the real tree, so it fails the moment a remnant reappears rather than
// waiting for a build to notice. Two deliberate allowances:
//
//   * references inside *.test.ts files are fine — the guards themselves must be
//     able to name what they forbid;
//   * the historical Prisma migration that first added CLICKPESA is skipped by
//     name below. It records what was applied to real databases and rewriting it
//     would make the migration history lie; it is not a route for money.
// =============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Retired gateways whose NAME must not appear on a shipped file or directory. */
const FORBIDDEN_NAMES = /azampay|selcom|clickpesa/i;

/** Retired gateways whose ENV prefixes must not appear in a live env file. */
const FORBIDDEN_ENV_PREFIXES = ["AZAMPAY", "SELCOM", "CLICKPESA"];

/** The already-applied migration that introduced CLICKPESA — history, not config. */
const ALLOWED_PATHS = [/^prisma[\\/]migrations[\\/]20261001120000_clickpesa([\\/]|$)/];

/** Directories that are generated, vendored, or scratch — never shipped. */
const SKIP_DIRS = new Set(["node_modules", "coverage", "dist", "tmp-emu", ".freebuff"]);

function walk(
  dir: string,
  files: string[] = [],
  dirs: string[] = []
): { files: string[]; dirs: string[] } {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Hidden dirs (.git, .next, …) and generated/vendored trees are skipped.
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      dirs.push(full);
      walk(full, files, dirs);
    } else {
      files.push(full);
    }
  }
  return { files, dirs };
}

describe("no retired-gateway remnants", () => {
  const { files, dirs } = walk(ROOT);

  it("names no shipped file or directory after a retired gateway", () => {
    const offenders = [...files, ...dirs]
      // The guards themselves may name what they forbid.
      .filter((p) => !p.endsWith(".test.ts"))
      .map((p) => path.relative(ROOT, p))
      .filter((rel) => FORBIDDEN_NAMES.test(rel))
      .filter((rel) => !ALLOWED_PATHS.some((re) => re.test(rel)));

    expect(offenders).toEqual([]);
  });

  it("declares no retired-gateway variable in any live environment file", () => {
    // Environment files are hidden (dot-prefixed), so they are read directly
    // rather than through the tree walk above. Archived `.backup` copies are
    // skipped: they are snapshots of old configuration kept for a human to
    // inspect, not files the deployment reads.
    const envFiles = fs
      .readdirSync(ROOT)
      .filter((name) => /^\.env/.test(name))
      .filter((name) => !name.includes(".backup"))
      .filter((name) => fs.statSync(path.join(ROOT, name)).isFile());

    const offenders: string[] = [];
    for (const name of envFiles) {
      const text = fs.readFileSync(path.join(ROOT, name), "utf8");
      for (const prefix of FORBIDDEN_ENV_PREFIXES) {
        if (new RegExp(`^\\s*${prefix}[A-Z0-9_]*\\s*=`, "m").test(text)) {
          offenders.push(`${name} → ${prefix}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
