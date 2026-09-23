#!/usr/bin/env node
// =============================================================================
// GENHUB - Pre-launch audit
//
// Run:  node scripts/preflight.mjs                       (development report)
//       node scripts/preflight.mjs --production          (blocks: launch gate)
//       node scripts/preflight.mjs --url https://domain  (+ live health probe)
//       node scripts/preflight.mjs --gateway             (+ live HarakaPay float)
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
import { loadEnv, ok, warn, fail, assessSecret, hasRestRedis } from "./_env.mjs";
import { checkLockfileSync } from "./verify-lockfile.mjs";

loadEnv();

const args = process.argv.slice(2);
const productionMode = args.includes("--production");
const wantUrl = args.indexOf("--url");
let baseUrl = wantUrl !== -1 ? (args[wantUrl + 1] || "").replace(/\/+$/, "") : "";
if (baseUrl && !/^https?:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;
const wantGateway =
  args.includes("--gateway") || (productionMode && process.env.PAYMENT_SANDBOX !== "true");

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

console.log(`\n=== GENHUB PRE-FLIGHT ===${productionMode ? " (PRODUCTION)" : ""}\n`);

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
          "Fund the float in the HarakaPay dashboard. (Your order ids are the evidence to send their support.)"
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
