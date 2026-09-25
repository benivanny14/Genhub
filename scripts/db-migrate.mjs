#!/usr/bin/env node
// =============================================================================
// GENHUB - `npm run db:deploy` and `npm run db:status`
//
// Run:  npm run db:deploy                        (apply pending migrations)
//       npm run db:status                        (report what is applied)
//       npm run db:deploy -- --env-from .env.vercel
//
// -----------------------------------------------------------------------------
// WHY THIS WRAPPER EXISTS INSTEAD OF `"db:deploy": "prisma migrate deploy"`
//
// The Prisma CLI reads `.env` and nothing else — it has never heard of
// `.env.local`. This repo deliberately keeps DATABASE_URL OUT of `.env`, because
// Prisma CLIENT reads `.env` too, and that switches off the rail in
// src/tests/setup-env.ts that holds the money-moving suites away from the live
// database. Measured, not theorised: putting the URL in `.env` made twenty
// suites run against production. Credentials belong in `.env.local`, which only
// Next.js and that setup file read.
//
// The consequence was that the documented command could not run AT ALL:
//
//   $ npm run db:deploy
//   Error code: P1012
//   error: Environment variable not found: DATABASE_URL.
//
// A clean checkout therefore could not apply its own schema: the migrations
// existed, the database existed, and the only way to join them was a shell
// incantation nobody had written down. That is the failure this file removes —
// and it is the reason a schema change shipped without its migration on
// 2026-09-25.
//
// -----------------------------------------------------------------------------
// TWO THINGS IT DOES THAT THE CLI CANNOT
//
//   1. Loads EXACTLY ONE environment file — `.env.local`, or the path after
//      `--env-from` — through scripts/_env.mjs, which is the same helper
//      preflight and verify:env use. One rule, one home: loading two files means
//      a value missing from the one you meant to check is quietly supplied by
//      the other.
//
//   2. Says which database it is about to change, before changing it. A
//      migration has no undo, and "which host did that just run against?" is a
//      question nobody should have to reconstruct from shell history. The
//      password is never printed — only host, database and schema.
//
// Environment variables already in the shell win over the file, so
// `DATABASE_URL=... npm run db:deploy` behaves the way it always did.
// =============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSingleEnv } from "./_env.mjs";

// -----------------------------------------------------------------------------
// Pure helpers — pinned by src/tests/db-migrate.test.ts
// -----------------------------------------------------------------------------

/**
 * The commands this wrapper will forward, keyed by the npm script that reaches
 * them. Anything else is refused by name rather than handed to the CLI, so a
 * typo cannot silently become a different Prisma command.
 */
export const COMMANDS = {
  deploy: ["migrate", "deploy"],
  status: ["migrate", "status"],
  push: ["db", "push"],
  migrate: ["migrate", "dev"],
  seed: ["db", "seed"],
  studio: ["studio"],
};

/**
 * Commands that can WRITE in ways the others cannot. `migrate dev` may reset the
 * database when it finds drift, and `db push` makes the schema match without
 * recording a migration at all — neither may be aimed at customers by accident,
 * so the target is printed louder for them.
 */
export const DESTRUCTIVE = new Set(["migrate", "push"]);

/**
 * Read `command` and `--env-from` out of argv.
 *
 * `--env-from` has to be consumed with its value, not merely skipped: the path
 * is a bare word, and a naive "first argument that is not a flag" scan would
 * report `.env.vercel` as the command name.
 *
 * @param {string[]} args  process.argv.slice(2)
 * @returns {{ command: string, envFrom: string, unknown: string[] }}
 */
export function parseArgv(args = []) {
  const rest = [];
  let envFrom = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env-from") {
      envFrom = (args[i + 1] || "").trim();
      i++;
      continue;
    }
    if (arg.startsWith("--env-from=")) {
      envFrom = arg.slice("--env-from=".length).trim();
      continue;
    }
    rest.push(arg);
  }

  const [command = "deploy", ...unknown] = rest.filter((a) => !a.startsWith("--"));
  return { command, envFrom, unknown };
}

/**
 * Break a Postgres connection string into the parts worth printing.
 * Returns null when the string cannot be parsed at all — which is itself the
 * answer ("this is not a connection string"), so callers report it rather than
 * throwing.
 */
export function describeDatabaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    const schema = url.searchParams.get("schema") || "public";
    return {
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port || "",
      database,
      schema,
      user: decodeURIComponent(url.username || ""),
    };
  } catch {
    return null;
  }
}

/**
 * A connection string safe to print: the password replaced, nothing else lost.
 *
 * Deliberately not a regex over the whole string. `https://user:pw@h/x` and
 * `postgresql://user:p%40ss@h/x` both have to come out redacted, and a URL that
 * fails to parse must NOT fall through as "print it as-is" — an unparseable
 * string is exactly the one that might be a password in the wrong box.
 */
export function redactDatabaseUrl(raw) {
  const value = String(raw || "");
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!url.password) return value;
    url.password = "***";
    return url.toString();
  } catch {
    return "(connection string could not be parsed — not printed)";
  }
}

/** True when the host is this machine, so the script can say so out loud. */
export function isLocalHost(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(
    String(host || "").toLowerCase()
  );
}

/**
 * How to run the Prisma CLI.
 *
 * Deliberately NOT `node_modules/.bin/prisma`. On Windows that is `prisma.cmd`,
 * a batch file, which can only be started through cmd.exe — and cmd.exe splits
 * the command line on spaces, so in a checkout whose path contains one
 * (`C:\Users\dell\OneDrive\Documents\Desktop\Genz after work`) the run died with
 * 'C:\...\Genz' is not recognized as an internal or external command, after the
 * script had already announced the database it was about to change.
 *
 * Instead: read the package's own `bin` entry and run it with the Node that is
 * already running — no shell, no shim, no quoting rules. The `npx` fallback only
 * matters when node_modules is empty, and it is quoted for the same reason.
 */
export function prismaBinary() {
  const pkgPath = join(process.cwd(), "node_modules", "prisma", "package.json");
  if (existsSync(pkgPath)) {
    try {
      const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
      const entry = typeof bin === "string" ? bin : bin?.prisma;
      const script = entry ? join(process.cwd(), "node_modules", "prisma", entry) : "";
      if (script && existsSync(script)) {
        return { command: process.execPath, args: [script], shell: false };
      }
    } catch {
      /* a broken package.json falls through to npx, which will say why */
    }
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return {
    command: npx,
    args: ["--no-install", "prisma"],
    // A space in the path is what broke the .cmd shim; quote this one too.
    shell: process.platform === "win32" && process.cwd().includes(" "),
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main() {
  const { command, envFrom, unknown } = parseArgv(process.argv.slice(2));

  const forwards = COMMANDS[command];
  if (!forwards) {
    console.error(
      `\n  \u2717 Unknown command "${command}".\n` +
        `    Use: npm run db:${Object.keys(COMMANDS).join("  |  npm run db:")}\n`
    );
    process.exit(2);
  }
  if (unknown.length) {
    console.error(`\n  \u2717 Unexpected argument(s): ${unknown.join(" ")}\n`);
    process.exit(2);
  }

  const resolved = loadSingleEnv(envFrom ? ["--env-from", envFrom] : []);
  if ("error" in resolved) {
    console.error(`\n  \u2717 ${resolved.error} — ${resolved.hint}\n`);
    process.exit(2);
  }

  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    // The exact failure this file was written to replace, with the fix attached.
    console.error(
      `\n  \u2717 DATABASE_URL is not set, so there is no database to migrate.\n\n` +
        `    Read: ${resolved.loaded ? resolve(process.cwd(), resolved.file) : `(no ${resolved.file} in this checkout)`}\n\n` +
        "    Prisma reads .env and never .env.local, and this repo keeps the URL in\n" +
        "    .env.local on purpose — see the header of scripts/db-migrate.mjs. Add it:\n\n" +
        '      DATABASE_URL="postgresql://user:password@host/db?sslmode=require"\n\n' +
        "    or point this run at another file:\n\n" +
        "      npm run db:deploy -- --env-from .env.vercel\n\n" +
        "    (npx vercel env pull .env.vercel --environment=production, then the line above.)\n"
    );
    process.exit(2);
  }

  const target = describeDatabaseUrl(url);
  if (!target) {
    console.error(
      `\n  \u2717 DATABASE_URL in ${resolved.file} is not a parseable connection string\n` +
        `    (${redactDatabaseUrl(url)}).\n`
    );
    process.exit(2);
  }
  if (!target.protocol.startsWith("postgres")) {
    console.error(
      `\n  \u2717 DATABASE_URL is a "${target.protocol}" URL, but this schema is postgresql.\n`
    );
    process.exit(2);
  }

  console.log(`\n=== GENHUB ${command === "deploy" ? "MIGRATE DEPLOY" : "MIGRATE STATUS"} ===\n`);
  console.log(`  Environment file : ${resolved.loaded ? resolved.file : `(none — shell only)`}`);
  console.log(`  Database         : ${target.host}${target.port ? `:${target.port}` : ""}/${target.database}`);
  console.log(`  Schema           : ${target.schema}`);
  if (target.user)  console.log(`  User             : ${target.user}`);
  if (isLocalHost(target.host)) {
    console.log("  ! that host is THIS MACHINE — a local database, not the deployed one");
  }
  if (DESTRUCTIVE.has(command)) {
    console.log(
      "  ! this command can rewrite or reset the schema without recording a migration —\n" +
        "    acceptable for a throwaway database, not for the one customers are on"
    );
  }
  console.log("");

  const { command: bin, args: binArgs, shell } = prismaBinary();
  const result = spawnSync(bin, [...binArgs, ...forwards], {
    stdio: "inherit",
    // The loaded value must reach the child. spawnSync inherits a COPY of
    // process.env, so it does; `env` is passed explicitly to make that obvious
    // to the next reader rather than implied.
    env: process.env,
    shell,
  });

  if (result.error) {
    console.error(`\n  \u2717 Could not start the Prisma CLI: ${result.error.message}\n`);
    process.exit(1);
  }

  if (result.status === 0) {
    console.log(
      `\n  \u2713 ${command === "deploy" ? "Migrations applied" : "Schema status reported"} on ${target.host}/${target.database}\n` +
        `    Prove it again any time:  npm run db:status\n`
    );
  }
  process.exit(result.status ?? 1);
}

// Only run when invoked as a command: the test file imports the pure helpers
// above, and importing must not try to migrate anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
