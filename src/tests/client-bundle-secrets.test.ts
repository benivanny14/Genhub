// =============================================================================
// GENHUB - No secret value reaches a browser
//
// This is the test the whole "secrets stay server-side" claim rests on, and it
// works by comparing the REAL values in this environment against the REAL bytes
// of the production build. Nothing here prints a secret: a failure names the
// file and the variable, never the value.
//
// It runs against `.next/static` (the JavaScript a browser downloads) and
// `public/` (anything served verbatim). It is skipped, loudly, when there is no
// build to scan — a green result on a missing artifact would be the most
// dangerous possible outcome.
// =============================================================================

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The variables whose VALUE must never appear in anything a browser receives. */
const SERVER_ONLY_VARS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "CRON_SECRET",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BUNNY_STORAGE_ACCESS_KEY",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_TOKEN_SECRET",
  "BUNNY_STREAM_WEBHOOK_SECRET",
  "CLICKPESA_API_KEY",
  "CLICKPESA_CLIENT_ID",
  "CLICKPESA_CHECKSUM_KEY",
  "CLICKPESA_WEBHOOK_TOKEN",
  "SMTP_PASS",
  "AT_API_KEY",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Only text-ish files: a secret inside a .woff is not readable anyway. */
const TEXT = /\.(js|mjs|cjs|css|html|json|txt|map|xml|svg|webmanifest)$/i;

// =============================================================================
// The guard that would have caught the leak before a build existed.
//
// A `"use client"` file that imports lib/config pulls the whole server config
// object — database URL, JWT secret, Bunny keys — into the bundle graph. The
// build-time scan below catches the result; this catches the CAUSE, in a second,
// with no build required.
// =============================================================================
describe("client components", () => {
  const srcDir = join(process.cwd(), "src");
  const sources = walk(srcDir).filter((file) => /\.(ts|tsx)$/.test(file));
  const importsServerConfig = (text: string) =>
    /from\s+["']@\/lib\/config["']/.test(text) || /require\(["']@\/lib\/config["']\)/.test(text);

  it("never import the server-only config module", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      const isClient = /^\s*["']use client["']/m.test(text);
      if (isClient && importsServerConfig(text)) {
        offenders.push(file.replace(process.cwd(), ""));
      }
    }
    expect(
      offenders,
      `client components must import '@/lib/public-config' instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

describe("the production client bundle", () => {
  const buildDir = join(process.cwd(), ".next", "static");
  const files = existsSync(buildDir)
    ? walk(buildDir).filter((file) => TEXT.test(file))
    : [];

  it("has a build to scan (or the check is meaningless)", () => {
    // Deliberately a test and not a silent skip: this file's guarantee is worth
    // nothing without an artifact, and `npm run build` runs before the suite in
    // CI. If it fails here, the build has not been produced yet.
    expect(
      files.length,
      "no `.next/static` output found — run `npm run build` before the test suite"
    ).toBeGreaterThan(0);
  });

  it("contains no server-only environment value", () => {
    const leaked: string[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const name of SERVER_ONLY_VARS) {
        const value = process.env[name];
        // Short values are not searchable (a 4-character password would match
        // everything), and a placeholder is not a secret.
        if (!value || value.length < 12) continue;
        if (content.includes(value)) {
          // Path and variable NAME only — never the value itself.
          leaked.push(`${file} contains ${name}`);
        }
      }
    }

    expect(leaked, leaked.join("\n")).toEqual([]);
  });

  it("publishes nothing from public/ that names a server variable", () => {
    const publicDir = join(process.cwd(), "public");
    const published = walk(publicDir).filter((file) => TEXT.test(file));
    const offenders: string[] = [];

    for (const file of published) {
      const content = readFileSync(file, "utf8");
      for (const name of SERVER_ONLY_VARS) {
        if (content.includes(name)) offenders.push(`${file} names ${name}`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
