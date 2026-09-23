// =============================================================================
// GENHUB - Vitest env setup
// Next.js loads .env.local automatically; plain vitest does not. This setup
// file parses .env.local into process.env BEFORE test files import config /
// prisma, so integration tests see DATABASE_URL, gateway keys, etc.
// Never overrides variables that are already set (NODE_ENV=test stays "test").
// =============================================================================

import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env.local");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Safety rail: the E2E suite must NEVER hit a real payment gateway, even when
// .env.local has PAYMENT_SANDBOX=false for manual live testing. Tests always
// run through the sandbox completion endpoint.
process.env.PAYMENT_SANDBOX = "true";

// =============================================================================
// Harness default: the suite has to pass on a machine that has never seen
// .env.local.
//
// That machine is CI, and it is the only place a fresh install ever happens —
// so a test that quietly depends on a developer's file is worse than a failing
// one: it is green on the laptop and red in the pipeline, and "is this safe to
// deploy?" stops having one answer.
//
// HARAKAPAY_WEBHOOK_TOKEN is the one that bit. The webhook route only compares
// the token when one is configured (it fails *open* on an empty value), so with
// the variable absent the "rejects webhooks with the wrong shared token" test
// was handed a 200 and the purchase suites could not build a signed callback
// URL at all. Both were correct code failing for an environment reason.
//
// This is a default and not an override: .env.local is read first and a value
// already in the environment wins, so anyone testing against a real token still
// sees it. Real protection lives at the other end — a production build refuses
// to run without a genuine token (scripts/verify-env.mjs).
// =============================================================================
const TEST_WEBHOOK_TOKEN = "test-webhook-token-not-a-real-secret";
if (!process.env.HARAKAPAY_WEBHOOK_TOKEN) {
  process.env.HARAKAPAY_WEBHOOK_TOKEN = TEST_WEBHOOK_TOKEN;
}

// =============================================================================
// Safety rail: the test suite must NEVER write to the database that serves real
// users.
//
// This matters more than it looks. The DB-backed suites are not read-only: they
// create creators, move money, release matured earnings and claw refunds back.
// `.env.local` points DATABASE_URL at the managed production database, which is
// exactly the file `npm test` reads — so a plain `npm test` would have started
// paying out of and deleting from live data. Nothing warns you; a green run
// just means the writes "worked".
//
// Resolution order:
//   1. TEST_DATABASE_URL          — a throwaway database (a Neon branch is free
//                                   and disposable). Best option.
//   2. DATABASE_URL, if it is local.
//   3. Nothing: DATABASE_URL is cleared, so every DB-backed suite skips itself
//      (they gate on `process.env.DATABASE_URL ? describe : describe.skip`)
//      instead of failing. Prisma constructs fine without it and only throws if
//      something actually queries — so a missed gate fails loudly, never
//      silently against production.
//
// Deliberate override: ALLOW_TESTS_ON_EXTERNAL_DB=1. Only ever point that at a
// database you are willing to have rewritten.
// =============================================================================

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"];

/** Hostname of a connection string, or null if it cannot be read at all. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** True when the connection string points at this machine. */
function isLocal(url: string): boolean {
  const host = hostOf(url);
  return host !== null && LOCAL_HOSTS.includes(host);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const configured = process.env.DATABASE_URL;
const force = process.env.ALLOW_TESTS_ON_EXTERNAL_DB === "1";

if (testDatabaseUrl && !force) {
  // Named explicitly for tests, so it is used as-is. If it is not local, say so
  // — the person needs to know which database their run is about to rewrite.
  process.env.DATABASE_URL = testDatabaseUrl;
  if (!isLocal(testDatabaseUrl)) {
    console.info(`[tests] using TEST_DATABASE_URL at ${hostOf(testDatabaseUrl)} (not local)`);
  }
} else if (configured && !isLocal(configured) && !force) {
  const host = hostOf(configured);
  delete process.env.DATABASE_URL;
  console.info(
    `[tests] DATABASE_URL points at ${host ?? "an external database"}, so the ` +
      "database-backed suites are SKIPPED — they create, pay out and delete real rows.\n" +
      "        To run them, set TEST_DATABASE_URL to a throwaway database " +
      "(a Neon branch works), or set ALLOW_TESTS_ON_EXTERNAL_DB=1 to accept " +
      "that the suite will rewrite whatever DATABASE_URL names.",
  );
}
