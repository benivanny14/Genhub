#!/usr/bin/env node
// =============================================================================
// GENHUB - Environment verification (build-time guard)
//
// Run:  node scripts/verify-env.mjs            -> advisory (dev / local build)
//       node scripts/verify-env.mjs --strict   -> blocks (production pipeline)
//
// Wired into `prebuild`, so a production build cannot ship with placeholder
// secrets. In development it only prints the report — a local `npm run build`
// must never fail because the machine has no Bunny key.
//
// "Production" is detected from the platform (VERCEL_ENV / NODE_ENV) rather than
// from `next build`'s own NODE_ENV, because `prebuild` runs before Next starts
// and would otherwise always look like production on a laptop.
// =============================================================================

import { loadEnv, hasRestRedis } from "./_env.mjs";

loadEnv();

const args = process.argv.slice(2);
const forceStrict = args.includes("--strict");
const platformSaysProduction =
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT === "production" ||
  process.env.RENDER === "true";
const strict = forceStrict || platformSaysProduction;

const env = (k) => (process.env[k] || "").trim();
const isLocal = (v) => !v || /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(v);

const ROOT =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ||
  process.env.VERCEL_URL ||
  null;

const blockers = [];
const warnings = [];

function check(ok, message) {
  if (!ok) blockers.push(message);
}

// ---------------------------------------------------------------- Critical
check(
  !!env("DATABASE_URL"),
  "DATABASE_URL is missing — the app has no database"
);
check(
  !isLocal(env("DATABASE_URL")) && !!env("DATABASE_URL"),
  "DATABASE_URL points at a local database — production data must live in managed Postgres"
);
check(
  !!env("JWT_SECRET") && env("JWT_SECRET") !== "dev-secret-change-in-production",
  "JWT_SECRET is missing or still the development default — sessions would be forgeable"
);
check(
  !!env("CRON_SECRET") && env("CRON_SECRET") !== "dev-cron-secret" && env("CRON_SECRET").length >= 12,
  "CRON_SECRET is missing, still the dev placeholder, or shorter than 12 characters — the cron routes either refuse to run or are guessable"
);
check(
  !isLocal(env("NEXT_PUBLIC_APP_URL")),
  `NEXT_PUBLIC_APP_URL is "${env("NEXT_PUBLIC_APP_URL") || "(unset)"}" — must be the public https:// domain ` +
    "(SEO, referral links, and the HarakaPay webhook_url are built from it)"
);

// --------------------------------------------------------------- Payments
check(
  !!env("HARAKAPAY_API_KEY"),
  "HARAKAPAY_API_KEY is missing — checkout will fail"
);
check(
  !!env("HARAKAPAY_WEBHOOK_TOKEN") && env("HARAKAPAY_WEBHOOK_TOKEN").length >= 12,
  "HARAKAPAY_WEBHOOK_TOKEN is missing or shorter than 12 characters — payment callbacks cannot be verified"
);
check(
  env("PAYMENT_SANDBOX") !== "true",
  "PAYMENT_SANDBOX=true — no USSD push is ever sent and no real money moves"
);

// ------------------------------------------------------------------ Media
check(
  !!env("BUNNY_STREAM_API_KEY") && !!env("BUNNY_STREAM_LIBRARY_ID"),
  "Bunny Stream credentials are missing — video upload and playback cannot work"
);
check(
  !!env("BUNNY_CDN_HOSTNAME"),
  "BUNNY_CDN_HOSTNAME is missing — playback and download URLs cannot be built"
);
check(
  !!env("BUNNY_TOKEN_SECRET"),
  "BUNNY_TOKEN_SECRET is missing — paid video URLs are not signed, and with Token Authentication " +
    "off on the pull zone they can be shared freely outside the paywall"
);

// ---------------------------------------------------------- Infrastructure
check(
  !!env("SMTP_HOST"),
  "SMTP_HOST is missing — password-reset and welcome emails are only written to logs, so users cannot recover accounts"
);
check(
  hasRestRedis() || !isLocal(env("REDIS_URL")),
  "No managed Redis — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or move REDIS_URL off localhost. Rate limiting degrades to per-instance and caches reset on every deploy"
);

// -------------------------------------------------------------- Warnings
if (!env("AT_API_KEY")) {
  warnings.push(
    "AT_API_KEY is not set — phone-only accounts cannot receive password-reset SMS"
  );
}
if (!env("BUNNY_STORAGE_ZONE") || !env("BUNNY_STORAGE_ACCESS_KEY")) {
  warnings.push("Bunny storage zone is not set — thumbnail uploads use the URL field only");
}
if (env("CRON_SECRET").length >= 12 && env("CRON_SECRET").length < 24) {
  warnings.push(
    `CRON_SECRET is only ${env("CRON_SECRET").length} characters — rotate it to 32+ random bytes before launch ` +
      "(openssl rand -hex 32)"
  );
}
if (!env("NEXT_PUBLIC_COMPANY_ADDRESS") || !env("NEXT_PUBLIC_COMPANY_LEGAL_NAME")) {
  warnings.push(
    "NEXT_PUBLIC_COMPANY_LEGAL_NAME / NEXT_PUBLIC_COMPANY_ADDRESS are not set — the 18 U.S.C. §2257 page " +
      "cannot name a records custodian, which is a legal requirement for this content"
  );
}
if (env("NEXT_PUBLIC_APP_URL") && isLocal(env("NEXT_PUBLIC_APP_URL")) && ROOT) {
  warnings.push(
    `The host exposes ${ROOT}, so the app URL falls back to it — set NEXT_PUBLIC_APP_URL explicitly instead`
  );
}

// ------------------------------------------------------------------ Report
const label = strict ? "strict (production pipeline)" : "advisory (development)";
console.log(`\n=== GENHUB environment check — ${label} ===\n`);

if (blockers.length === 0) {
  console.log("  ✓ Every critical setting is present\n");
} else {
  for (const b of blockers) console.log(`  ✗ ${b}`);
  console.log("");
}
for (const w of warnings) console.log(`  ! ${w}`);
if (warnings.length) console.log("");

if (blockers.length > 0 && strict) {
  console.log(
    `BLOCKING: ${blockers.length} critical setting(s) missing for production. ` +
      "Fix the ✗ lines above (see PRODUCTION.md), then build again.\n"
  );
  process.exit(1);
}

if (blockers.length > 0) {
  console.log(
    `Advisory only: ${blockers.length} setting(s) would BLOCK a production build. ` +
      "Run `npm run preflight:prod` before deploying. Local development continues.\n"
  );
} else {
  console.log("Environment is production-ready.\n");
}

process.exit(0);
