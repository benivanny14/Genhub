#!/usr/bin/env node
// =============================================================================
// GENHUB - Prove every credential actually WORKS
// Run:  npm run verify:live
//
// `preflight:prod` answers "did you set this?". This answers the harder
// question: "does it work?" — by opening a real connection to each service.
//
// Why both are needed: a connection string with a typo, an API key from the
// sandbox account, a Bunny token-authentication key that was never switched on,
// a database that needs ?sslmode=require — all of them LOOK configured. The
// difference only shows up when something tries to use them, and the worst time
// to find out is after a customer has paid.
//
// Every check here is READ-ONLY or self-cleaning:
//   Postgres  SELECT 1
//   Redis     PING
//   Bunny     library lookup (GET)
//   CDN       HEAD on the pull-zone hostname
//   SMTP      transport verify (opens a session, sends nothing)
//   HarakaPay GET /api/v1/balance
//   App URL   GET /api/health
//
// The Redis, Bunny and SMTP probes live in ./_probes.mjs because
// `preflight:prod` runs the same three — one definition, so the two commands
// cannot disagree about whether a service works.
//
// Exit codes: 0 = everything configured works. 1 = something configured is
// broken. Missing values are reported as "not configured" and never fail the
// run, so this is usable mid-setup.
// =============================================================================

import { loadEnv, assessSecret } from "./_env.mjs";
import { GREEN, RED, AMBER, DIM, probeRedis, probeBunny, probeSmtp } from "./_probes.mjs";

loadEnv();

const env = (k) => (process.env[k] || "").trim();
const isLocal = (v) => /localhost|127\.0\.0\.1/i.test(v || "");

const results = [];
function record({ name, state, detail }) {
  results.push({ name, state, detail });
  const mark = state === "ok" ? GREEN : state === "fail" ? RED : AMBER;
  const label = state === "skip" ? "skip" : state.toUpperCase();
  console.log(`  ${mark} ${name.padEnd(14)} ${label.padEnd(6)} ${detail || ""}`);
}

const timeout = (ms) => AbortSignal.timeout(ms);

// =============================================================================
// 1. Postgres
// =============================================================================
async function checkDatabase() {
  const url = env("DATABASE_URL");
  if (!url) return record({ name: "Postgres", state: "skip", detail: "DATABASE_URL not set" });

  // The mistake that costs an afternoon: serverless + a direct (non-pooled)
  // Neon/Supabase connection exhausts connections and fails under load, not at
  // build time. Worth flagging loudly while it is cheap to fix.
  if (/neon\.tech|supabase\.co|render\.com|aiven\.io/.test(url) && !/sslmode=/.test(url)) {
    record({
      name: "Postgres",
      state: "warn",
      detail: "managed host without ?sslmode=require — add it, most managed providers reject plaintext",
    });
  }
  if (/neon\.tech/.test(url) && !/-pooler/.test(url)) {
    console.log(
      `       ${AMBER} Neon: this is the DIRECT connection. On Vercel use the POOLED one\n` +
        `         (host contains "-pooler") — a serverless app opens a connection per\n` +
        `         instance and will exhaust the direct limit under load.`
    );
  }

  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const rows = await prisma.$queryRawUnsafe("SELECT 1 AS ok");
    const users = await prisma.user.count().catch(() => null);
    const migrations = await prisma
      .$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = '_prisma_migrations'`
      )
      .catch(() => [{ n: 0 }]);
    await prisma.$disconnect();

    const hasMigrations = migrations?.[0]?.n > 0;
    record({
      name: "Postgres",
      state: rows?.[0]?.ok === 1 ? "ok" : "fail",
      detail:
        `connected${isLocal(url) ? " (LOCAL — fine for now, move it before launch)" : ""}` +
        ` · users: ${users ?? "?"}` +
        `${hasMigrations ? "" : ` · ${AMBER} no _prisma_migrations table — run npm run db:deploy`}`,
    });
  } catch (error) {
    record({ name: "Postgres", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

// =============================================================================
// 2-4. Redis, Bunny Stream + CDN, SMTP — see ./_probes.mjs
// =============================================================================

// =============================================================================
// 5. HarakaPay
// =============================================================================
async function checkHarakapay() {
  const key = env("HARAKAPAY_API_KEY");
  if (!key) return record({ name: "HarakaPay", state: "skip", detail: "HARAKAPAY_API_KEY not set" });

  const base = env("HARAKAPAY_BASE_URL") || "https://harakapay.net";
  try {
    const res = await fetch(`${base}/api/v1/balance`, {
      headers: { "X-API-Key": key },
      signal: timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.success === false) {
      record({
        name: "HarakaPay",
        state: "fail",
        detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 110)} — key rejected`,
      });
      return;
    }

    const float = Number(body.float_balance ?? 0);
    record({
      name: "HarakaPay",
      state: float > 0 ? "ok" : "fail",
      detail:
        `key valid · wallet ${body.wallet_balance ?? 0} · float ${float}` +
        (float <= 0
          ? ` · ${RED} float is 0: accepts collects and reports "USSD push sent", but orders never settle`
          : ""),
    });
  } catch (error) {
    record({ name: "HarakaPay", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

// =============================================================================
// 6. The deployed app itself
// =============================================================================
async function checkAppUrl() {
  const url = env("NEXT_PUBLIC_APP_URL");
  if (!url) return record({ name: "App URL", state: "skip", detail: "NEXT_PUBLIC_APP_URL not set" });

  if (isLocal(url)) {
    return record({
      name: "App URL",
      state: "warn",
      detail: `${url} — HarakaPay cannot reach a localhost webhook (polling still settles payments)`,
    });
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    record({
      name: "App URL",
      state: res.ok ? "ok" : "fail",
      detail: `${url}/api/health -> HTTP ${res.status}${body?.status ? ` (${body.status})` : ""}`,
    });
  } catch (error) {
    record({
      name: "App URL",
      state: "fail",
      detail: `${url} unreachable (${String(error.message || error).slice(0, 90)})`,
    });
  }
}

// =============================================================================
// 7. Local secrets: strength, not connectivity
// =============================================================================
function checkSecrets() {
  for (const [name, value] of [
    ["JWT_SECRET", env("JWT_SECRET")],
    ["CRON_SECRET", env("CRON_SECRET")],
    ["Webhook token", env("HARAKAPAY_WEBHOOK_TOKEN")],
  ]) {
    const assessed = assessSecret(value);

    if (assessed.ok) {
      record({
        name,
        state: "ok",
        detail: `${value.length} chars, ${assessed.entropy.toFixed(2)} bits/char`,
      });
      continue;
    }

    // A placeholder is only tolerable while it stays local; the danger is
    // carrying the same value into production, where it becomes a published key.
    const productionRelevant = env("NODE_ENV") === "production" || !isLocal(env("NEXT_PUBLIC_APP_URL"));
    record({
      name,
      state: productionRelevant ? "fail" : "warn",
      detail:
        `${assessed.reason}. ` +
        (productionRelevant
          ? "Anyone who guesses this can forge sessions — rotate with: openssl rand -hex 32"
          : "fine while it stays local, but never carry this value into production"),
    });
  }

  const sandbox = env("PAYMENT_SANDBOX");
  const legalName = env("NEXT_PUBLIC_COMPANY_LEGAL_NAME");
  const legalAddress = env("NEXT_PUBLIC_COMPANY_ADDRESS");

  record({
    name: "Live payments",
    state: sandbox === "false" ? "ok" : "warn",
    detail:
      sandbox === "false"
        ? "PAYMENT_SANDBOX=false — real USSD pushes"
        : `PAYMENT_SANDBOX=${sandbox || "(unset)"} — no real charge is ever attempted`,
  });

  // 18 U.S.C. 2257 / 28 C.F.R. 75.2: the records-custodian statement on /2257 is
  // a legal filing, not decoration. Selling adult content without a named
  // entity and a real place of business is a criminal exposure, not a bug.
  const legalOk = !!(legalName && legalAddress);
  record({
    name: "2257 records",
    state: legalOk ? "ok" : "fail",
    detail: legalOk
      ? `${legalName} · ${legalAddress.slice(0, 40)}`
      : `missing ${[!legalName && "NEXT_PUBLIC_COMPANY_LEGAL_NAME", !legalAddress && "NEXT_PUBLIC_COMPANY_ADDRESS"].filter(Boolean).join(" + ")} — /2257 cannot name a records custodian`,
  });
}

// =============================================================================
// Run
// =============================================================================
console.log("\n=== GENHUB connection check === (this opens real connections)\n");

await checkDatabase();
for (const result of await probeRedis()) record(result);
for (const result of await probeBunny()) record(result);
for (const result of await probeSmtp()) record(result);
await checkHarakapay();
await checkAppUrl();
checkSecrets();

const failed = results.filter((r) => r.state === "fail");
const warned = results.filter((r) => r.state === "warn");
const skipped = results.filter((r) => r.state === "skip");

console.log("");
if (skipped.length) {
  console.log(`${DIM} Not configured yet (${skipped.length}): ${skipped.map((r) => r.name).join(", ")}`);
}
console.log(
  `\n${failed.length === 0 ? "Everything configured is working." : `${failed.length} configured value(s) are broken.`}` +
    (warned.length ? ` ${warned.length} warning(s) — see ${AMBER} above.` : "") +
    "\n"
);

process.exit(failed.length > 0 ? 1 : 0);
