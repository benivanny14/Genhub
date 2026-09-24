// =============================================================================
// GENHUB - Which environment file a gate read
//
// Every gate in scripts/ asks "is this configured?" against one file. Which file
// is not a detail: reading `.env.local` answers a question about this checkout,
// and the same gates are used to reproduce a build that a hosting provider just
// failed, against values pulled from that provider. Get the file wrong and the
// gate is confidently wrong, in the direction that costs a deploy.
//
// Two properties are pinned here, and both were real bugs first:
//
//   * the flag is `--env-from`, because Node claims `--env-file` for itself and
//     reads it even after the script path — so the flag with the obvious name
//     never reaches our code at all; and
//   * exactly ONE file is loaded, because loading a pulled file on top of
//     `.env.local` merges the two lists, and the gate then reports on the union
//     — announcing "every critical setting is present" about a deployment that is
//     missing most of them.
// =============================================================================

import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv, envFileFromArgs, loadSingleEnv } from "../../scripts/_env.mjs";

// `.env.local.<suffix>` is covered by the `.env.local.*` rule in .gitignore, and
// every key below is prefixed so it cannot collide with the real environment.
const created: string[] = [];
const KEYS = ["PROBE_A", "PROBE_B", "PROBE_SHARED", "PROBE_MISSING"];

// Read and clear the probe keys by NAME, never as `process.env.PROBE_A`.
//
// src/tests/env-template.test.ts scans src/ and scripts/ for `process.env.KEY`
// and fails if .env.example does not document the key — which is exactly right,
// and exactly why a synthetic key must not be written that way. Naming these
// here would demand that every developer add PROBE_A to the real template.
const env = (key: string) => process.env[key];
const unset = (key: string) => {
  delete process.env[key];
};

function writeEnvFile(suffix: string, body: string): string {
  const name = `.env.local.${suffix}`;
  writeFileSync(join(process.cwd(), name), body, "utf8");
  created.push(name);
  return name;
}

afterEach(() => {
  for (const name of created.splice(0)) {
    rmSync(join(process.cwd(), name), { force: true });
  }
  for (const key of KEYS) unset(key);
});

describe("envFileFromArgs", () => {
  it("is empty when the flag is absent", () => {
    expect(envFileFromArgs(["--production"])).toBe("");
  });

  it("reads the path after the flag", () => {
    expect(envFileFromArgs(["--env-from", ".env.vercel"])).toBe(".env.vercel");
  });

  it("is empty when the flag has no value, rather than taking the next flag", () => {
    expect(envFileFromArgs(["--production", "--env-from"])).toBe("");
  });

  it("is NOT --env-file", () => {
    // Node 20.6+ consumes `--env-file` itself, wherever it appears in argv, and
    // exits with "<path>: not found" before a line of ours runs. Renaming this
    // back to the obvious thing would produce a flag that is silently ignored on
    // a runner and hits the runtime's error path on a laptop.
    expect(envFileFromArgs(["--env-file", ".env.vercel"])).toBe("");
    const source = readFileSync(join(process.cwd(), "scripts", "_env.mjs"), "utf8");
    expect(source).not.toContain('args.indexOf("--env-file")');
  });
});

describe("loadSingleEnv", () => {
  it("loads the pulled file and nothing else", () => {
    const pulled = writeEnvFile("pulled", "PROBE_A=from-pulled\n");

    const resolved = loadSingleEnv(["--env-from", pulled]);

    expect(resolved).toEqual({ file: pulled, pulled: true, loaded: true });
    expect(env("PROBE_A")).toBe("from-pulled");
  });

  it("does not let a later file overwrite a value already loaded", () => {
    // The mechanism behind the merge bug, isolated: `loadEnv` never overwrites,
    // so loading a second file silently keeps the first file's value. A gate that
    // loaded `.env.local` after a pulled file would therefore report the
    // developer's values as if they were the deployment's.
    const first = writeEnvFile("first", "PROBE_SHARED=first\n");
    const second = writeEnvFile("second", "PROBE_SHARED=second\n");

    loadEnv(first);
    loadEnv(second);

    expect(env("PROBE_SHARED")).toBe("first");
  });

  it("treats a named file that does not exist as an error, not as a fallback", () => {
    // Falling back to `.env.local` here would answer a question nobody asked,
    // in the confident voice of a check that passed.
    const resolved = loadSingleEnv(["--env-from", ".env.local.does-not-exist"]);

    expect(resolved).toHaveProperty("error");
    expect("loaded" in resolved).toBe(false);
    expect(String((resolved as { hint: string }).hint)).toContain("vercel env pull");
  });

  it("falls back to .env.local when no flag is given, and says it was not pulled", () => {
    const resolved = loadSingleEnv([]);

    expect(resolved).toMatchObject({ file: ".env.local", pulled: false });
  });
});

describe("both gates take the flag", () => {
  const read = (name: string) =>
    readFileSync(join(process.cwd(), "scripts", name), "utf8");

  it("preflight and verify:env resolve their file through the shared helper", () => {
    // One implementation, so the two cannot disagree about which file they read —
    // the same reason the probes live in scripts/_probes.mjs.
    for (const name of ["preflight.mjs", "verify-env.mjs"]) {
      const source = read(name);
      expect(source).toContain("loadSingleEnv");
      expect(source).not.toMatch(/^loadEnv\(\)/m);
    }
  });

  it("says the pulled file is a snapshot, not the deployment", () => {
    // A pulled value can be deleted afterwards, so a green run against it is
    // evidence about a file, never proof about production.
    for (const name of ["preflight.mjs", "verify-env.mjs"]) {
      expect(read(name)).toContain("SNAPSHOT");
    }
  });
});
