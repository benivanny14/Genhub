// =============================================================================
// GENHUB - Application Configuration
// Centralized env configuration with type-safe access
// =============================================================================

// =============================================================================
// App URL resolution
// =============================================================================
// NEXT_PUBLIC_APP_URL is what the browser, the SEO tags and — critically — the
// HarakaPay `webhook_url` are built from. Forgetting it on a host that knows its
// own address is an easy way to silently break payment callbacks, so when it is
// unset (or still localhost) we fall back to the platform's own URL variables
// before giving up. Without a hosted fallback the webhook simply cannot reach a
// deployment, and the customer's payment only lands because the client polls
// /api/payments/status — which is a safety net, not the design.

export type AppUrlSource =
  | "NEXT_PUBLIC_APP_URL"
  | "VERCEL_PROJECT_PRODUCTION_URL"
  | "VERCEL_URL"
  | "localhost";

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");
const withHttps = (host: string) =>
  /^https?:\/\//.test(host) ? host : `https://${host}`;

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
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Genhub",
  nodeEnv: process.env.NODE_ENV || "development",

  // Compliance identity. 28 C.F.R. 75.2 makes these values PUBLIC, and a DMCA
  // notice is only useful if it lands in an inbox somebody reads - so they live
  // in exactly one place. They used to be typed by hand into eight files, which
  // meant the address an operator configured in NEXT_PUBLIC_SUPPORT_EMAIL
  // reached one page while DMCA, Terms, Privacy, Support, About and the Footer
  // kept publishing a different one. On /2257 itself a sentence contradicted
  // the constant three lines above it.
  compliance: {
    legalName: process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME || "Genhub",
    address: process.env.NEXT_PUBLIC_COMPANY_ADDRESS || "",
    supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@genhub.co.tz",
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
  },

  // HarakaPay — the only payment gateway (USSD push via mobile money)
  harakaPay: {
    apiKey: process.env.HARAKAPAY_API_KEY || "",
    baseUrl: process.env.HARAKAPAY_BASE_URL || "https://harakapay.net",
    // Shared secret appended as ?t= to webhook_url; verifies callbacks are ours
    webhookToken: process.env.HARAKAPAY_WEBHOOK_TOKEN || "",
    // PAYMENT_SANDBOX=true keeps local dev off the real gateway (no USSD pushes)
    sandbox: process.env.PAYMENT_SANDBOX === "true",
    // The float the gateway settles USSD prompts from, below which an admin is
    // told (services/harakapay-float-alert.service.ts). At 0 the gateway does not
    // refuse a payment — it accepts it, answers "USSD push sent", and never
    // delivers the prompt — so the alarm has to fire on the way down. Zero or
    // unset means the default floor, not "no floor": the whole point is to hear
    // about it before the bottom.
    floatFloorTzs: Number(process.env.HARAKAPAY_FLOAT_FLOOR_TZS || 0),
  },

  // Platform Business Rules
  business: {
    platformFeePercent: 30,    // 30% platform cut
    creatorFeePercent: 70,     // 70% creator cut
    holdingPeriodDays: 14,     // 14-day holding period
    minPayoutAmount: 30000,    // Minimum 30,000 TZS payout
    maxStrikes: 3,             // 3 strikes = ban
    teaserMinDuration: 15,     // Minimum preview seconds
    teaserMaxDuration: 30,     // Maximum preview seconds
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
  if (config.harakaPay.sandbox) {
    warnings.push("PAYMENT_SANDBOX=true — payments are simulated; set to false for live gateways");
  }
  if (!config.harakaPay.apiKey) {
    warnings.push("HARAKAPAY_API_KEY is empty — checkout will fail in production");
  }
  if (!config.harakaPay.webhookToken) {
    warnings.push("HARAKAPAY_WEBHOOK_TOKEN is empty — payment webhooks will be accepted without a shared secret");
  }
  if (!config.cron.secret) {
    warnings.push("CRON_SECRET is empty — cron routes refuse to run in production");
  }
  if (config.appUrlSource === "localhost") {
    warnings.push(
      "The app URL is still localhost — SEO links, referral links and the HarakaPay webhook_url will be wrong. " +
        "Set NEXT_PUBLIC_APP_URL to the public https:// domain."
    );
  } else if (config.appUrlSource !== "NEXT_PUBLIC_APP_URL") {
    warnings.push(
      `NEXT_PUBLIC_APP_URL is unset, so the app URL was inferred from ${config.appUrlSource} (${config.appUrl}). ` +
        "Set it explicitly so the webhook_url never depends on the hosting provider."
    );
  }
  if (!config.databaseUrl) {
    warnings.push("DATABASE_URL is not set");
  }
  if (!config.bunny.apiKey || !config.bunny.cdnHostname) {
    warnings.push("Bunny.net Stream credentials are incomplete — uploads/playback will fail");
  }
  if (!config.email.host) {
    warnings.push("SMTP_HOST is not set — password-reset and welcome emails are only logged, users cannot recover accounts");
  }
  if (!config.sms.apiKey) {
    warnings.push("AT_API_KEY is not set — phone-only users cannot receive password-reset SMS");
  }
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
