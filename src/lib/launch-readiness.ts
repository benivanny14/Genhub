// =============================================================================
// GENHUB - "What is still missing before real users?" answered inside the app
//
// `npm run preflight:prod` is the launch gate, and it is the right answer when
// you have a shell. An operator on a phone does not, and the admin panel's
// System readiness card could only ever say "some warnings" — never *which*
// ones are launch-blocking and what to do about each.
//
// This is the same question answered from the deployment's own environment. It
// is deliberately a STRICT SUBSET of what preflight checks:
//
//   * no network, so it cannot be the thing that hangs a page load;
//   * no lockfile or repository checks, which describe a checkout rather than a
//     deployment;
//   * secret strength by length and wording only — preflight also measures
//     entropy per character, and the two rules kept here are ones preflight
//     applies too. Being a subset is the point: a secret that fails here fails
//     there, so this list can miss a blocker but can never invent one. Two
//     lists that disagree about the same deployment are worse than one list.
//
// The §2257 identity is checked here as well as in preflight because it is the
// one item that is a legal requirement (28 C.F.R. § 75.2) rather than an
// engineering preference.
//
// Safety: this names environment variables that are missing, never values that
// are set. It is served to admins only, from an authenticated route.
// =============================================================================

import config from "./config";

export interface LaunchBlocker {
  /** Stable key, so the UI can de-duplicate and tests can name one. */
  id: string;
  /** What is missing or wrong, in one line. */
  label: string;
  /** Where to get it — the reader should not have to search for this. */
  fix: string;
}

export interface LaunchReadiness {
  ready: boolean;
  blockers: LaunchBlocker[];
}

// The two rules preflight also applies, and the only two kept here. See the
// header for why entropy is left to the script.
const PLACEHOLDER_PATTERN =
  /dev[-_]|test[-_]|change[-_]?me|placeholder|example|sample|default|your[-_]?(key|secret|token)|^secret$/i;

/** The reason a secret is unfit to sign tokens, or null when it is fine. */
function weakSecretReason(value: string): string | null {
  if (!value) return "is not set";
  if (PLACEHOLDER_PATTERN.test(value)) return "reads like a placeholder rather than a generated secret";
  if (value.length < 32) return `is only ${value.length} characters (32+ needed)`;
  return null;
}

const isManagedRedis = () =>
  Boolean(config.redis.restUrl && config.redis.restToken) ||
  !config.redisUrl.includes("localhost");

/**
 * Everything still standing between this deployment and real users.
 *
 * Ordered the way the failures hurt: being unreachable or unable to sign a
 * session first, then being unable to take money, then the things that make the
 * site quietly worse for the people already using it.
 */
export function launchBlockers(): LaunchBlocker[] {
  const blockers: LaunchBlocker[] = [];
  const add = (id: string, label: string, fix: string) => blockers.push({ id, label, fix });

  // --- reachable, and able to keep a session
  if (!config.databaseUrl) {
    add("databaseUrl", "DATABASE_URL is not set — there is no database", "SETUP.md §1");
  } else if (config.databaseUrl.includes("localhost")) {
    add(
      "databaseUrl",
      "DATABASE_URL points at localhost — the deployment has no database",
      "SETUP.md §1 (use the pooled connection string for a serverless host)"
    );
  }

  if (config.appUrlSource === "localhost" || !/^https:\/\//.test(config.appUrl)) {
    add(
      "appUrl",
      `The app URL is ${config.appUrl} — it must be the public https:// domain`,
      "SETUP.md §1: NEXT_PUBLIC_APP_URL, then redeploy (NEXT_PUBLIC_* are baked in at build time)"
    );
  }

  const jwt = weakSecretReason(config.jwtSecret);
  if (jwt) {
    add("jwtSecret", `JWT_SECRET ${jwt} — every session token is signed with it`, "openssl rand -hex 32");
  }

  const cron = weakSecretReason(config.cron.secret);
  if (cron) {
    add(
      "cronSecret",
      `CRON_SECRET ${cron} — without it the schedules cannot run`,
      "openssl rand -hex 24, then set it on the repository too (PRODUCTION.md §4.0.1)"
    );
  }

  // --- able to take money
  if (config.harakaPay.sandbox) {
    add(
      "gatewayLive",
      "PAYMENT_SANDBOX=true — payments are simulated, no USSD push and no real money",
      "SETUP.md §4"
    );
  }
  if (!config.harakaPay.apiKey) {
    add("gatewayKey", "HARAKAPAY_API_KEY is not set — checkout fails immediately", "SETUP.md §4");
  }
  if (!config.harakaPay.webhookToken) {
    add(
      "gatewayWebhook",
      "HARAKAPAY_WEBHOOK_TOKEN is not set — payment callbacks would be accepted without a shared secret",
      "SETUP.md §4"
    );
  }

  // --- able to deliver video, mail and compliance
  if (!config.bunny.apiKey || !config.bunny.libraryId || !config.bunny.cdnHostname) {
    add(
      "bunnyStream",
      "Bunny Stream credentials are incomplete — uploads and CDN playback cannot work",
      "SETUP.md §3 (BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_API_KEY, BUNNY_CDN_HOSTNAME)"
    );
  }
  if (!config.bunny.tokenSecret) {
    add(
      "bunnyToken",
      "BUNNY_TOKEN_SECRET is not set — signed playback URLs would be handed out unsigned",
      "SETUP.md §3"
    );
  }
  if (!config.email.host) {
    add(
      "smtp",
      "SMTP_HOST is not set — password-reset and welcome emails only reach the server log, so users cannot recover their accounts",
      "SETUP.md §5"
    );
  }
  if (!isManagedRedis()) {
    add(
      "redis",
      "No managed Redis — rate limiting falls back to per-instance memory and caches reset on every deploy",
      "SETUP.md §2 (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or a managed REDIS_URL)"
    );
  }

  // --- legal
  if (!(process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME || "").trim() || !(process.env.NEXT_PUBLIC_COMPANY_ADDRESS || "").trim()) {
    add(
      "compliance",
      "NEXT_PUBLIC_COMPANY_LEGAL_NAME / NEXT_PUBLIC_COMPANY_ADDRESS are missing — /2257 cannot name a records custodian, which is a legal requirement",
      "SETUP.md §6 (28 C.F.R. § 75.2 — the registered entity name and a real address)"
    );
  }

  return blockers;
}

/** The verdict, with the count a UI wants to render next to it. */
export function launchReadiness(): LaunchReadiness {
  const blockers = launchBlockers();
  return { ready: blockers.length === 0, blockers };
}
