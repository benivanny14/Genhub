// =============================================================================
// GENHUB - No AzamPay remnants (guard test)
//
// AzamPay was integrated and then deliberately removed; ClickPesa is the only
// gateway. src/tests/gateway-guard.test.ts already keeps a *source identifier*
// from creeping back in. This suite closes the two gaps that guard leaves open:
//
//   1. a file or directory NAMED azampay (a route folder, a migration, an
//      integration module) — the identifier scan only reads file *contents*;
//   2. an AZAMPAY_* variable in any environment file — those are not shipped
//      source, so no source scan would ever see them.
//
// It walks the real tree, so it fails the moment a remnant reappears rather than
// waiting for a build to notice. Existing references inside *.test.ts files are
// allowed: the guards themselves must be able to name what they forbid.
// =============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** The gateway that must never come back. Matched case-insensitively. */
const FORBIDDEN = /azampay/i;

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

describe("no AzamPay remnants", () => {
  const { files, dirs } = walk(ROOT);

  it("names no shipped file or directory after the decommissioned gateway", () => {
    const offenders = [...files, ...dirs]
      // The guards themselves may name what they forbid.
      .filter((p) => !p.endsWith(".test.ts"))
      .filter((p) => FORBIDDEN.test(path.relative(ROOT, p)));

    expect(offenders.map((p) => path.relative(ROOT, p))).toEqual([]);
  });

  it("declares no AZAMPAY_* variable in any environment file", () => {
    // Environment files are hidden (dot-prefixed), so they are read directly
    // rather than through the tree walk above.
    const envFiles = fs
      .readdirSync(ROOT)
      .filter((name) => /^\.env/.test(name))
      .filter((name) => fs.statSync(path.join(ROOT, name)).isFile());

    const offenders: string[] = [];
    for (const name of envFiles) {
      const text = fs.readFileSync(path.join(ROOT, name), "utf8");
      if (/^\s*AZAMPAY[A-Z0-9_]*\s*=/m.test(text)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
