#!/usr/bin/env node
// =============================================================================
// GENHUB - Pre-launch audit
//
// Run:  node scripts/preflight.mjs                       (development report)
//       node scripts/preflight.mjs --production          (blocks: launch gate)
//       node scripts/preflight.mjs --url https://domain  (+ live health probe)
//       node scripts/preflight.mjs --gateway             (+ live HarakaPay float)
//       node scripts/preflight.mjs --live                (+ Redis/Bunny/SMTP probes)
//
// `--production` implies `--live`: the launch gate has to answer "does it work",
// not only "was it set". In development the probes stay opt-in so `preflight`
// remains a fast, offline report.
//
// Exits 1 when launch BLOCKERS remain. In development the "go-live" items are
// warnings (placeholders are expected); with --production they become blockers,
// because none of them can be missing on a site taking real money.
//
// The HarakaPay float check is the one thing that cannot be fixed in code: with
// `float_balance: 0` the gateway accepts our request, reports "USSD push sent",
// and never delivers the prompt or settles the charge.
// =============================================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSingleEnv, ok, warn, fail, assessSecret, hasRestRedis } from "./_env.mjs";
import { checkLockfileSync } from "./verify-lockfile.mjs";
import { probeRedis, probeBunny, probeSmtp } from "./_probes.mjs";

// -----------------------------------------------------------------------------
// WHOSE environment is this?
//
// The most misread thing about this script, and the reason it now says so out
// loud: it reads THIS CHECKOUT's .env.local, so a variable set in the hosting
// provider's dashboard is invisible here. Read without that, a red
// `preflight:prod` on a laptop looks like the deployment is broken when only the
// laptop is out of date — and, worse, a green one gets taken as proof about
// production. Both errors cost the same afternoon, and neither is a bug in the
// checks.
//
// A deployment's own environment can only be asked from inside it:
//   * the app's answer — Admin -> System readiness, GET /api/admin/launch-readiness
//   * from a laptop      — APP_URL=https://your-domain npm run launch:check:remote
//   * a pulled copy of it — npx vercel env pull .env.vercel --environment=production
//                           npm run preflight:prod -- --env-from .env.vercel
//
// That last one is the whole point of `--env-from`: it is the only way to run
// THIS gate against the list the deployment actually holds, with the same wording
// and the same exit code, offline — before another push. The flag is not called
// `--env-file` because Node claims that one; see scripts/_env.mjs.
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const envResolution = loadSingleEnv(args);
if ("error" in envResolution) {
  console.error(`\n  \u2717 ${envResolution.error} — ${envResolution.hint}\n`);
  process.exit(2);
}
const envFileName = envResolution.file;
const envFrom = envResolution.pulled ? envFileName : "";
const envFilePath = resolve(process.cwd(), envFileName);
const readEnvFile = envResolution.loaded;

const productionMode = args.includes("--production");
const wantUrl = args.indexOf("--url");
let baseUrl = wantUrl !== -1 ? (args[wantUrl + 1] || "").replace(/\/+$/, "") : "";
if (baseUrl && !/^https?:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;
const wantGateway =
  args.includes("--gateway") || (productionMode && process.env.PAYMENT_SANDBOX !== "true");
const wantLive = productionMode || args.includes("--live");

let blockers = 0;
let warnings = 0;
const inProduction = productionMode || process.env.NODE_ENV === "production";

/** Always a blocker, in every mode. */
const must = (cond, passMsg, failMsg) => {
  if (cond) ok(passMsg);
  else {
    fail(failMsg);
    blockers++;
  }
};

/**
 * A blocker once we are actually launching, a warning on a laptop.
 * `blocking` decides which list it lands in; the message is shared so the
 * developer sees the same wording in both modes.
 */
const goLive = (cond, passMsg, failMsg) => {
  if (cond) {
    ok(passMsg);
    return;
  }
  if (inProduction) {
    fail(failMsg);
    blockers++;
  } else {
    warn(failMsg);
    warnings++;
  }
};

const env = (k) => (process.env[k] || "").trim();
const isLocal = (v) => !v || /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(v);

/** Bound a promise, so the gate can never hang on a database that is waking up. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out (no answer within ${ms / 1000}s)`)),
        ms
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Turn a raw driver/Prisma failure into the thing to actually do about it.
 *
 * The messages these libraries emit are near-identical for a wrong password, a
 * wrong host and a database that is simply asleep, so a gate that only printed
 * them would send the reader hunting for the wrong fault.
 */
function diagnoseDatabaseError(raw) {
  const message = String(raw || "").replace(/\s+/g, " ").trim();
  if (/can't reach database server|could not connect|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|P1001/i.test(message)) {
    return (
      `${message} — no route to the host. Check the connection string, and that a managed ` +
      "database is awake (free/idle tiers such as Neon suspend and refuse the first connection)"
    );
  }
  if (/authentication failed|password authentication|P1000/i.test(message)) {
    return `${message} — the password in DATABASE_URL is rejected`;
  }
  if (/does not exist|P1003/i.test(message)) {
    return `${message} — the database name in DATABASE_URL does not exist on that server`;
  }
  return message;
}

/**
 * Open one real connection to Postgres. Read-only: `SELECT 1`.
 *
 * Bounded at 15s: Prisma's own connect timeout is generous, and a database that
 * is waking up would otherwise stall the gate for a minute before it says
 * anything. The timeout is not a false failure — a launch gate that takes longer
 * than that to reach its own database is telling you something.
 */
async function checkDatabaseReach() {
  const started = Date.now();
  let prisma;
  try {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
    const rows = await withTimeout(
      prisma.$queryRawUnsafe("SELECT 1 AS ok"),
      15_000,
      "SELECT 1"
    );
    if (rows?.[0]?.ok !== 1) {
      return { reachable: false, detail: "connected, but SELECT 1 returned nothing" };
    }
    return { reachable: true, detail: `SELECT 1 answered in ${Date.now() - started}ms` };
  } catch (error) {
    return {
      reachable: false,
      detail: diagnoseDatabaseError(error?.message || error).slice(0, 240),
    };
  } finally {
    try {
      await prisma?.$disconnect();
    } catch {
      /* a connection that never opened has nothing to close */
    }
  }
}

console.log(`\n=== GENHUB PRE-FLIGHT ===${productionMode ? " (PRODUCTION)" : ""}\n`);
console.log(
  readEnvFile
    ? `Reading ${envFilePath}`
    : `No ${envFileName} in this checkout — reading the shell environment only`
);
console.log("");
if (envFrom) {
  warn(
    `${envFrom} is a SNAPSHOT of that environment, not the environment itself —`
  );
  warn("only the variables that were pulled are here, and a pulled value can be deleted afterwards.");
  console.log("");
}
if (productionMode && readEnvFile && !envFrom) {
  warn(
    "this report describes THIS CHECKOUT, not your deployment. A variable you set"
  );
  warn(
    "in Vercel / Netlify / Railway is not visible from here, and NEXT_PUBLIC_* are"
  );
  warn(
    "baked in at BUILD time — changing one needs a redeploy, not a restart. To ask"
  );
  warn("the deployment about itself:  APP_URL=https://your-domain npm run launch:check:remote");
  console.log("");
}

// --------------------------------------------------------- Repository state
// The one check here that is about the checkout rather than the environment,
// and a blocker in every mode: the deploy installs with `npm ci`, which
// resolves nothing, so a package.json edit that was never installed is fatal
// there and invisible here. `tsc`, the suite and `next build` all run against
// the node_modules that the old edit left behind, so every other gate in this
// file is green while the deployment cannot start.
console.log("Repository state:");
{
  let report;
  try {
    report = checkLockfileSync(
      JSON.parse(readFileSync("package.json", "utf8")),
      JSON.parse(readFileSync("package-lock.json", "utf8"))
    );
  } catch (error) {
    report = {
      errors: [
        `could not read package.json / package-lock.json (${error.message}) — run this from the project root`,
      ],
      warnings: [],
      checked: 0,
    };
  }

  must(
    report.errors.length === 0,
    `package.json and package-lock.json agree on ${report.checked} direct dependencies`,
    "package.json and package-lock.json disagree — the deploy's `npm ci` would refuse to install:\n      " +
      report.errors.join("\n      ")
  );
  for (const warning of report.warnings) {
    warn(warning);
    warnings++;
  }
}
console.log("");

// -------------------------------------------------------------- Blockers
console.log("Blockers (must be fixed before real users):");
must(!!env("DATABASE_URL"), "DATABASE_URL is set", "DATABASE_URL missing — the app has no database");
goLive(
  !isLocal(env("DATABASE_URL")),
  "DATABASE_URL points at an external database",
  "DATABASE_URL points at localhost — production data must live in managed Postgres"
);

// "DATABASE_URL is set" is not "there is a database there". Two failures look
// identical in an environment list and both pass every check above:
//
//   * a suspended managed database — Neon's free tier sleeps when idle and
//     refuses the first connection while it wakes, and
//   * a connection string that parses but points at the wrong host, database or
//     password.
//
// Each fails on the deploy's first query, i.e. after the site looks "up". This
// is a blocker in EVERY mode on purpose — unlike a missing SMTP host, no
// environment can run without its database — and it is the same read-only probe
// `npm run verify:live` uses (`SELECT 1` through Prisma).
if (env("DATABASE_URL")) {
  const { reachable, detail } = await checkDatabaseReach();
  must(reachable, `database is reachable — ${detail}`, `cannot reach the database — ${detail}`);
}

const appUrl = env("NEXT_PUBLIC_APP_URL");
must(
  !!appUrl && !appUrl.includes("localhost"),
  `NEXT_PUBLIC_APP_URL = ${appUrl}`,
  `NEXT_PUBLIC_APP_URL is "${appUrl || "(unset)"}" — must be your real https:// domain (SEO, webhooks, referral links)`
);
const jwtSecret = assessSecret(env("JWT_SECRET"));
must(
  jwtSecret.ok,
  `JWT_SECRET is a strong secret (${jwtSecret.entropy.toFixed(2)} bits/char)`,
  `JWT_SECRET is unusable: ${jwtSecret.reason} — generate one with: openssl rand -hex 32`
);
const cronSecret = assessSecret(env("CRON_SECRET"));
must(
  cronSecret.ok,
  `CRON_SECRET is a strong secret (${cronSecret.entropy.toFixed(2)} bits/char)`,
  `CRON_SECRET is unusable: ${cronSecret.reason} — cron routes would be unprotected; generate with: openssl rand -hex 32`
);
must(
  !!env("HARAKAPAY_API_KEY"),
  "HARAKAPAY_API_KEY is set",
  "HARAKAPAY_API_KEY missing — checkout would fail"
);
must(
  !!env("HARAKAPAY_WEBHOOK_TOKEN") && env("HARAKAPAY_WEBHOOK_TOKEN").length >= 12,
  "HARAKAPAY_WEBHOOK_TOKEN is set",
  "HARAKAPAY_WEBHOOK_TOKEN missing or too short — payment callbacks unverifiable"
);

// ---------------------------------------------------- Go-live requirements
console.log("\nGo-live requirements" + (inProduction ? " (blocking):" : " (warnings in dev):"));
goLive(
  env("PAYMENT_SANDBOX") !== "true",
  `PAYMENT_SANDBOX=${env("PAYMENT_SANDBOX") || "(unset = live)"} — gateway is live`,
  "PAYMENT_SANDBOX=true — no USSD push is sent and no real money moves"
);
goLive(
  !!env("BUNNY_STREAM_API_KEY") && !!env("BUNNY_STREAM_LIBRARY_ID") && !!env("BUNNY_CDN_HOSTNAME"),
  "Bunny Stream credentials are set — upload + playback can work",
  "Bunny Stream vars are missing — creators cannot upload and videos cannot stream (run: npm run smoke:bunny)"
);
goLive(
  !!env("BUNNY_TOKEN_SECRET"),
  "BUNNY_TOKEN_SECRET is set — playback URLs are signed",
  "BUNNY_TOKEN_SECRET is missing — paid video URLs are not signed and can be shared freely"
);
goLive(
  !!env("SMTP_HOST"),
  `SMTP configured (${env("SMTP_HOST")})`,
  "SMTP_HOST missing — password-reset/welcome emails only go to logs; users cannot recover accounts"
);
// Either Upstash pair counts. Demanding REDIS_URL specifically would fail a
// deployment that is correctly configured with the REST pair, which is the pair
// Upstash's own quickstart hands you first.
goLive(
  hasRestRedis(),
  "Redis is an external/managed instance",
  env("UPSTASH_REDIS_REST_URL") || env("UPSTASH_REDIS_REST_TOKEN")
    ? "Only one of UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN is set — both are required"
    : "No managed Redis — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or point REDIS_URL away from localhost. Rate limiting degrades to per-instance and caches reset per deploy"
);
goLive(
  !!env("NEXT_PUBLIC_COMPANY_LEGAL_NAME") && !!env("NEXT_PUBLIC_COMPANY_ADDRESS"),
  "2257 records custodian details are set",
  "NEXT_PUBLIC_COMPANY_LEGAL_NAME / NEXT_PUBLIC_COMPANY_ADDRESS missing — the §2257 page cannot name a custodian (legal requirement)"
);

// ------------------------------------------------- Live connection checks
// Everything above asks whether a value was SET. These ask whether it WORKS —
// a different question, and the one a launch actually depends on: a typo in a
// connection string, a Bunny account with Token Authentication still off, and an
// SMTP host that no longer resolves all pass every check above and then fail in
// front of a customer. The probes are the same ones `npm run verify:live` runs
// (see ./_probes.mjs), so the two commands cannot disagree about whether a
// service is up.
if (wantLive) {
  console.log("\nLive connection checks (opening real connections):");
  for (const probe of [probeRedis, probeBunny, probeSmtp]) {
    for (const result of await probe()) {
      if (result.state === "fail") {
        fail(`${result.name}: ${result.detail}`);
        blockers++;
      } else if (result.state === "warn") {
        warn(`${result.name}: ${result.detail}`);
        warnings++;
      } else if (result.state === "ok") {
        ok(`${result.name}: ${result.detail}`);
      }
      // `skip` prints nothing: the sections above already named what is missing,
      // and counting it here would report one gap twice.
    }
  }
}

// ------------------------------------------------------- Live gateway check
// The single blocker that is NOT ours to fix: an unfunded merchant account.
if (wantGateway && env("HARAKAPAY_API_KEY")) {
  const base = env("HARAKAPAY_BASE_URL") || "https://harakapay.net";
  console.log(`\nHarakaPay live account check: ${base}/api/v1/balance`);
  try {
    const res = await fetch(`${base}/api/v1/balance`, {
      headers: { "X-API-Key": env("HARAKAPAY_API_KEY") },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      fail(`balance lookup -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      blockers++;
    } else {
      const wallet = Number(body.wallet_balance ?? 0);
      const float = Number(body.float_balance ?? 0);
      ok(`API key is valid — wallet ${wallet}, float ${float}`);
      goLive(
        float > 0,
        "Merchant float is funded — collections can settle",
        `Merchant float is ${float} — HarakaPay accepts our request and reports "USSD push sent", ` +
          "but the prompt does not reach the customer and the order stays `processing` forever. " +
          "HarakaPay has to credit the float: use the dashboard top-up if your account has one, " +
          "and if it does not (the card only shows Wallet/Float balances), ask their support in " +
          "writing how the float is funded here. Activation for live collections is the other " +
          "thing to confirm in the same email. Your order ids are the evidence to include."
      );
    }
  } catch (error) {
    fail(`could not reach HarakaPay: ${error.message || error}`);
    blockers++;
  }
}

// ------------------------------------------------------ Live health probe
if (baseUrl) {
  console.log(`\nLive health probe: ${baseUrl}/api/health`);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (res.ok && data.status === "ok") {
      ok(`status=ok, database=${data.checks?.database}`);
    } else {
      fail(`status=${data.status || res.status}, database=${data.checks?.database}`);
      blockers++;
    }
    for (const w of data.warnings || []) {
      warn(w);
      warnings++;
    }
  } catch (error) {
    fail(`health probe failed: ${error.message || error}`);
    blockers++;
  }
}

// ----------------------------------------------------------------- Report
console.log(`\n=== ${blockers} blocker(s), ${warnings} warning(s) ===`);
if (productionMode && readEnvFile) {
  console.log(
    "Counted against " + envFilePath + " — a value you set only in your hosting\n" +
      "provider's dashboard is not in this file. Admin -> System readiness asks the\n" +
      "deployment itself."
  );
}
if (blockers > 0) {
  console.log(
    "Fix the blockers above, then re-run.\n" +
      "  Where to get each value:  SETUP.md\n" +
      "  Prove they work:          npm run verify:live\n" +
      "  Deploy checklist:         PRODUCTION.md\n"
  );
  process.exit(1);
}
console.log("Launch-ready from a configuration standpoint.\n");
