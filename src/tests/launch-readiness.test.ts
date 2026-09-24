// =============================================================================
// GENHUB - The launch gate, as the app answers it
//
// `npm run preflight:prod` is the authoritative list; this is the subset the
// admin panel can compute from the deployment's own environment, with no shell
// and no network. The property that matters is that it is a SUBSET: a secret
// this list rejects is one preflight rejects too, so it can miss a blocker but
// can never invent one. Two lists that disagree about the same deployment are
// worse than one list, which is what these tests exist to keep true.
//
// config resolves once at module load, so each case re-imports the module
// against a different environment — the same technique as app-url.test.ts.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "DATABASE_URL",
  "JWT_SECRET",
  "CRON_SECRET",
  "PAYMENT_SANDBOX",
  "HARAKAPAY_API_KEY",
  "HARAKAPAY_WEBHOOK_TOKEN",
  "SMTP_HOST",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BUNNY_STREAM_LIBRARY_ID",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_CDN_HOSTNAME",
  "BUNNY_TOKEN_SECRET",
  "NEXT_PUBLIC_COMPANY_LEGAL_NAME",
  "NEXT_PUBLIC_COMPANY_ADDRESS",
] as const;

const mutableEnv = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = mutableEnv[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = saved[key];
  }
  vi.resetModules();
});

/**
 * A deployment that would pass the gate. Everything a single test breaks is
 * broken *from* here, so a failure names the one thing that changed rather than
 * a pile of unrelated gaps.
 */
const READY: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@ep-genhub-pooler.c-7.us-east-2.aws.neon.tech/genhub?sslmode=require",
  NEXT_PUBLIC_APP_URL: "https://genhub.co.tz",
  JWT_SECRET: "3f9a1c0b57e2d84a6b1f0c9d8e7a6b5c4d3e2f10a9b8c7d6e5f4039281716a5b",
  CRON_SECRET: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293",
  PAYMENT_SANDBOX: "false",
  HARAKAPAY_API_KEY: "hpk_live_example",
  HARAKAPAY_WEBHOOK_TOKEN: "0b1c2d3e4f5a6b7c8d9e0f1a",
  SMTP_HOST: "smtp.resend.com",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "AX1cASQg-example",
  BUNNY_STREAM_LIBRARY_ID: "760553",
  BUNNY_STREAM_API_KEY: "bunny-key",
  BUNNY_CDN_HOSTNAME: "vz-example.b-cdn.net",
  BUNNY_TOKEN_SECRET: "bunny-token-secret",
  NEXT_PUBLIC_COMPANY_LEGAL_NAME: "Genhub Ltd",
  NEXT_PUBLIC_COMPANY_ADDRESS: "Dar es Salaam, Tanzania",
};

async function loadLaunch(overrides: Record<string, string | undefined> = {}) {
  const env = { ...READY, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
  // Exercise the absent-variable cases without inheriting the machine's own
  // .env.local values.
  for (const key of KEYS) {
    if (!(key in env)) delete mutableEnv[key];
  }

  return import("@/lib/launch-readiness");
}

const ids = (blockers: { id: string }[]) => blockers.map((b) => b.id);

describe("launchBlockers", () => {
  it("finds nothing blocking on a configured deployment", async () => {
    const { launchReadiness } = await loadLaunch();
    const verdict = launchReadiness();
    expect(ids(verdict.blockers)).toEqual([]);
    expect(verdict.ready).toBe(true);
  });

  it("treats a localhost app URL as blocking, because webhooks cannot reach it", async () => {
    const { launchBlockers } = await loadLaunch({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(ids(launchBlockers())).toContain("appUrl");
  });

  it("rejects a placeholder secret, not just a missing one", async () => {
    // The failure that motivated the strength rules in the first place: a
    // hand-typed stopgap that is long enough to look fine and is not.
    const { launchBlockers } = await loadLaunch({ JWT_SECRET: "dev-freebuff-secret-change-me-please" });
    expect(ids(launchBlockers())).toContain("jwtSecret");
  });

  it("rejects a short secret", async () => {
    const { launchBlockers } = await loadLaunch({ CRON_SECRET: "abc123" });
    expect(ids(launchBlockers())).toContain("cronSecret");
  });

  it("names the sandbox before it names anything else about payments", async () => {
    const { launchBlockers } = await loadLaunch({ PAYMENT_SANDBOX: "true" });
    expect(ids(launchBlockers())).toContain("gatewayLive");
  });

  it("stops on a missing SMTP host, because users could not recover accounts", async () => {
    const { launchBlockers } = await loadLaunch({ SMTP_HOST: undefined });
    expect(ids(launchBlockers())).toContain("smtp");
  });

  it("stops on the §2257 identity, which is a legal requirement rather than a preference", async () => {
    const { launchBlockers } = await loadLaunch({
      NEXT_PUBLIC_COMPANY_ADDRESS: undefined,
    });
    expect(ids(launchBlockers())).toContain("compliance");
  });

  it("stops when the database is absent or points at localhost", async () => {
    expect(ids((await loadLaunch({ DATABASE_URL: undefined })).launchBlockers())).toContain("databaseUrl");
    expect(
      ids((await loadLaunch({ DATABASE_URL: "postgresql://u:p@localhost:5432/genhub" })).launchBlockers())
    ).toContain("databaseUrl");
  });

  it("does not report a warning-only gap as a blocker", async () => {
    // Africa's Talking is recommended, not required: a blocked launch is a
    // different claim from a degraded one, and blurring them means the red block
    // stops being read.
    const { launchBlockers } = await loadLaunch();
    expect(ids(launchBlockers())).not.toContain("sms");
    expect(ids(launchBlockers())).not.toContain("atApiKey");
  });

  it("tells the reader where each missing value comes from", async () => {
    const { launchBlockers } = await loadLaunch({ PAYMENT_SANDBOX: "true", SMTP_HOST: undefined });
    for (const blocker of launchBlockers()) {
      expect(blocker.label.length).toBeGreaterThan(10);
      expect(blocker.fix.length).toBeGreaterThan(3);
    }
  });
});
