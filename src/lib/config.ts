// =============================================================================
// GENHUB - Application Configuration
// Centralized env configuration with type-safe access
// =============================================================================

// =============================================================================
// App URL resolution
// =============================================================================
// NEXT_PUBLIC_APP_URL is what the browser, the SEO tags and the referral links
// are built from. Forgetting it on a host that knows its own address is an easy
// way to silently break links, so when it is unset (or still localhost) we fall
// back to the platform's own URL variables before giving up. It also has to be
// right for the ClickPesa webhook dashboard entry, which points at
// /api/webhooks/clickpesa on this domain.

import publicConfig from "@/lib/public-config";

export type AppUrlSource =
  | "NEXT_PUBLIC_APP_URL"
  | "VERCEL_PROJECT_PRODUCTION_URL"
  | "VERCEL_URL"
  | "localhost";

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");
const withHttps = (host: string) =>
  /^https?:\/\//.test(host) ? host : `https://${host}`;

/**
 * A whole number from the environment, or the default when it is missing or
 * unusable.
 *
 * The fallback matters for a value like the daily spend cap: `Number("abc")` is
 * NaN, and a cap that quietly became NaN would refuse every purchase instead of
 * protecting one. An explicitly written `0` is kept — for the cap that is
 * "disabled" — but an EMPTY value is treated as absent, so an unset variable is
 * never mistaken for a request to switch the limit off.
 */
function intFromEnv(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function resolveAppUrl(): { url: string; source: AppUrlSource } {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (explicit && !explicit.includes("localhost")) {
    return { url: stripTrailingSlashes(explicit), source: "NEXT_PUBLIC_APP_URL" };
  }

  // Vercel exposes the stable production domain and the per-deployment URL.
  const productionHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  if (productionHost) {
    return {
      url: stripTrailingSlashes(withHttps(productionHost)),
      source: "VERCEL_PROJECT_PRODUCTION_URL",
    };
  }

  const deploymentHost = (process.env.VERCEL_URL || "").trim();
  if (deploymentHost) {
    return {
      url: stripTrailingSlashes(withHttps(deploymentHost)),
      source: "VERCEL_URL",
    };
  }

  return {
    url: stripTrailingSlashes(explicit) || "http://localhost:3000",
    source: "localhost",
  };
}

const resolvedAppUrl = resolveAppUrl();

const config = {
  // App
  appUrl: resolvedAppUrl.url,
  /** Where appUrl came from — surfaced by /api/health and the admin panel. */
  appUrlSource: resolvedAppUrl.source,
  // Name and compliance identity come from the client-safe module so a public
  // page and the server can never disagree about them.
  appName: publicConfig.appName,
  nodeEnv: process.env.NODE_ENV || "development",

  // Compliance identity. 28 C.F.R. 75.2 makes these values PUBLIC, and a DMCA
  // notice is only useful if it lands in an inbox somebody reads - so they live
  // in exactly one place. They used to be typed by hand into eight files, which
  // meant the address an operator configured in NEXT_PUBLIC_SUPPORT_EMAIL
  // reached one page while DMCA, Terms, Privacy, Support, About and the Footer
  // kept publishing a different one. On /2257 itself a sentence contradicted
  // the constant three lines above it.
  compliance: {
    legalName: publicConfig.compliance.legalName,
    address: publicConfig.compliance.address,
    supportEmail: publicConfig.compliance.supportEmail,
    // The public support line, and the reason it is here rather than typed into
    // the two pages that show it: the footer and /support published
    // "+255 700 000 000" — a reserved-looking number nobody owns — while the
    // custodian address said Seoul. A visitor who dials it reaches a stranger,
    // and a reviewer checking the platform's contact details finds a placeholder.
    // One value, one place, so the next change cannot reach one page and miss
    // the other.
    phone: publicConfig.compliance.phone,
  },

  // Database
  databaseUrl: process.env.DATABASE_URL!,

  // Redis — either pair works, and Upstash REST wins when both are present.
  // See lib/redis.ts for why the REST pair is a real backend and not a
  // decoration: Upstash hands out both, and anything the app does not read is
  // config that silently does nothing.
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redis: {
    restUrl: process.env.UPSTASH_REDIS_REST_URL || "",
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  },

  // JWT Auth
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-in-production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  cookieName: process.env.COOKIE_NAME || "genhub_token",

  // Bunny.net Stream
  bunny: {
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID || "",
    apiKey: process.env.BUNNY_STREAM_API_KEY || "",
    storageZone: process.env.BUNNY_STORAGE_ZONE || "",
    storageAccessKey: process.env.BUNNY_STORAGE_ACCESS_KEY || "",
    cdnHostname: process.env.BUNNY_CDN_HOSTNAME || "",
    tokenSecret: process.env.BUNNY_TOKEN_SECRET || "",
    // Stream webhook signing secret. Bunny signs every Stream callback with
    // HMAC-SHA256 over the raw body, keyed on the library's READ-ONLY API key
    // (see /api/webhooks/bunny and lib/bunny-webhook.ts). It is a SEPARATE value
    // from BUNNY_STREAM_API_KEY: that one is the read-write management key the
    // server uses, this one only ever verifies inbound callbacks, so it can be
    // rotated without breaking uploads. Empty disables signature checks in dev
    // and fails the route closed in production.
    webhookSecret: process.env.BUNNY_STREAM_WEBHOOK_SECRET || "",
  },

  // ClickPesa — the only payment gateway (USSD push via mobile money).
  //
  // Auth is a short-lived token minted from the client id + api key (see
  // lib/payments/clickpesa.ts). Callbacks authenticate two ways and either may
  // be used: an HMAC-SHA256 `checksum` signed with the checksum key (the
  // stronger option, and the one ClickPesa recommends), or a shared token the
  // operator puts in the webhook URL as ?t=… .
  clickPesa: {
    clientId: process.env.CLICKPESA_CLIENT_ID || "",
    apiKey: process.env.CLICKPESA_API_KEY || "",
    baseUrl:
      process.env.CLICKPESA_BASE_URL || "https://api.clickpesa.com/third-parties",
    // Shared secret the operator appends to the dashboard webhook URL (?t=…).
    webhookToken: process.env.CLICKPESA_WEBHOOK_TOKEN || "",
    // Checksum key from the ClickPesa dashboard. When set, every callback MUST
    // carry a valid signature — a body without one is refused.
    checksumKey: process.env.CLICKPESA_CHECKSUM_KEY || "",
    // PAYMENT_SANDBOX=true keeps local dev off the real gateway (no USSD pushes).
    // ClickPesa has no sandbox environment, so this is a local simulation only.
    sandbox: process.env.PAYMENT_SANDBOX === "true",
  },

  // Platform Business Rules
  business: {
    platformFeePercent: 30,    // 30% platform cut
    creatorFeePercent: 70,     // 70% creator cut
    holdingPeriodDays: 14,     // 14-day holding period
    minPayoutAmount: 30000,    // Minimum 30,000 TZS payout
    // The blue tick is bought, not earned. Priced per month, and the number is
    // here rather than in the service so the creator's screen, the admin's
    // approval and the charge all read the same one.
    blueTickMonthlyPrice: 10000, // TZS per month of the verification badge
    blueTickMonthDays: 30,       // a "month" is 30 days, so expiry is exact
    maxStrikes: 3,             // 3 strikes = ban
    teaserMinDuration: 15,     // Minimum preview seconds
    teaserMaxDuration: 30,     // Maximum preview seconds
    // How many videos one creator may hold. Bunny charges for storage and
    // transcoding, and a creator could previously reserve library slots without
    // limit — the only gate was approved KYC, which says who somebody is and
    // nothing about how much they may consume. Generous on purpose: this is a
    // ceiling against runaway use, not a business limit.
    maxVideosPerCreator: 500,
    // The most one account may SPEND from its wallet in a rolling 24 hours,
    // across every paid action (video purchases, subscriptions, tips and paid
    // messages). The per-transaction limits above bound a single charge; this
    // bounds a day of them, which is what a stolen session or a script abuses.
    // Generous on purpose — a ceiling against runaway use, not a business limit.
    // Set DAILY_SPEND_CAP=0 to disable it.
    dailySpendCap: intFromEnv(process.env.DAILY_SPEND_CAP, 500_000),
  },

  // Background jobs (Vercel cron / external schedulers call our cron routes)
  cron: {
    secret: process.env.CRON_SECRET || "",
  },

  // Transactional email (SMTP). Empty host = console transport (dev only).
  email: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    from: process.env.EMAIL_FROM || "Genhub <no-reply@genhub.local>",
  },

  // Transactional SMS (Africa's Talking). Empty key = console transport.
  sms: {
    apiKey: process.env.AT_API_KEY || "",
    username: process.env.AT_USERNAME || "Genhub",
    senderId: process.env.AT_SENDER_ID || "",
  },

  // Rate Limiting
  rateLimit: {
    auth: { max: 10, windowMs: 60_000 },          // 10 requests per minute
    upload: { max: 5, windowMs: 300_000 },         // 5 uploads per 5 minutes
    payment: { max: 20, windowMs: 60_000 },        // 20 requests per minute
    general: { max: 100, windowMs: 60_000 },       // 100 requests per minute
  },
} as const;

export default config;

/** Returns the direct Bunny Stream variables missing from this deployment. */
export function uploadStorageReadiness(): {
  bunnyConfigured: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!config.bunny.libraryId) missing.push("BUNNY_STREAM_LIBRARY_ID");
  if (!config.bunny.apiKey) missing.push("BUNNY_STREAM_API_KEY");
  return {
    bunnyConfigured: missing.length === 0,
    missing,
  };
}

// =============================================================================
// Production config audit — non-secret warnings surfaced by /api/health and
// PRODUCTION.md. Never includes actual secret values.
// =============================================================================
export function productionConfigWarnings(): string[] {
  if (config.nodeEnv !== "production") return [];

  const warnings: string[] = [];
  if (config.jwtSecret === "dev-secret-change-in-production") {
    warnings.push("JWT_SECRET is still the development default — set a strong random secret");
  }
  if (config.clickPesa.sandbox) {
    warnings.push("PAYMENT_SANDBOX=true — payments are simulated; set to false for live gateways");
  }
  if (!config.clickPesa.clientId) {
    warnings.push("CLICKPESA_CLIENT_ID is empty — checkout will fail in production");
  }
  if (!config.clickPesa.apiKey) {
    warnings.push("CLICKPESA_API_KEY is empty — checkout will fail in production");
  }
  if (!config.clickPesa.checksumKey && !config.clickPesa.webhookToken) {
    warnings.push(
      "Neither CLICKPESA_CHECKSUM_KEY nor CLICKPESA_WEBHOOK_TOKEN is set — payment webhooks would be accepted without proof they came from ClickPesa"
    );
  }
  if (!config.cron.secret) {
    warnings.push("CRON_SECRET is empty — cron routes refuse to run in production");
  }
  if (config.appUrlSource === "localhost") {
    warnings.push(
      "The app URL is still localhost — SEO links, referral links and the ClickPesa webhook URL will be wrong. " +
        "Set NEXT_PUBLIC_APP_URL to the public https:// domain."
    );
  } else if (config.appUrlSource !== "NEXT_PUBLIC_APP_URL") {
    warnings.push(
      `NEXT_PUBLIC_APP_URL is unset, so the app URL was inferred from ${config.appUrlSource} (${config.appUrl}). ` +
        "Set it explicitly so the ClickPesa webhook URL never depends on the hosting provider."
    );
  }
  if (!config.databaseUrl) {
    warnings.push("DATABASE_URL is not set");
  }
  if (!config.bunny.apiKey || !config.bunny.cdnHostname) {
    warnings.push("Bunny.net Stream credentials are incomplete — uploads/playback will fail");
  }
  // The names of missing Bunny variables are safe to expose; values and keys
  // never leave the server.
  const { bunnyConfigured, missing } = uploadStorageReadiness();
  if (!bunnyConfigured) {
    warnings.push(
      `Video uploads are unavailable: set ${missing.join(", ")}`
    );
  }
  if (!config.email.host) {
    warnings.push("SMTP_HOST is not set — password-reset and welcome emails are only logged, users cannot recover accounts");
  } else {
    // A host without a routable From is the classic silent mail failure: the
    // transport connects, the provider accepts the request, and every message is
    // then refused (or filed as spam) because the sending domain was never
    // verified. `genhub.local` is the shipped default and can never be a real
    // sender, so it is called out rather than left to look configured.
    const from = config.email.from;
    if (/\.local\b/i.test(from) || !/@[^\s<>]+\.[a-z]{2,}/i.test(from)) {
      warnings.push(
        `EMAIL_FROM is not a deliverable address ("${from}") — set it to an address on your verified sending domain or mail will be refused`
      );
    }
  }
  // AT_API_KEY is deliberately NOT warned about. Password reset is email-only
  // and sign-up requires an email, so no flow sends SMS any more — a warning
  // about a channel nothing uses is a warning people learn to skip. /api/health
  // still reports `sms` so an operator can see whether a provider is wired for
  // later.
  // Only warn when NEITHER backend is real. Telling someone their Redis is
  // misconfigured while working Upstash REST credentials sit in .env.local is
  // the kind of warning people learn to ignore.
  const hasRestRedis = Boolean(config.redis.restUrl && config.redis.restToken);
  if (!hasRestRedis && config.redisUrl.includes("localhost")) {
    warnings.push(
      "No managed Redis — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or point REDIS_URL at a managed server. " +
        "Rate limiting falls back to per-instance memory and caches reset on every deploy"
    );
  }
  if (Boolean(config.redis.restUrl) !== Boolean(config.redis.restToken)) {
    warnings.push(
      "Only one of UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN is set — both are required, so the REST backend is ignored"
    );
  }
  return warnings;
}
