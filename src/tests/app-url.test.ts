// =============================================================================
// GENHUB - App URL resolution
//
// The app URL feeds the HarakaPay `webhook_url`, SEO tags, referral links and
// password-reset emails. Getting it wrong is silent: payments still settle
// because the client polls the status endpoint, so nobody notices the gateway
// was never able to call us back.
//
// config resolves it once at module load, so each case re-imports the module
// with a different environment.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "NODE_ENV",
] as const;

// NODE_ENV is typed as read-only, and these tests must control it to exercise
// the production warning path.
const mutableEnv = process.env as Record<string, string | undefined>;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = mutableEnv[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete mutableEnv[k];
    else mutableEnv[k] = saved[k];
  }
  vi.resetModules();
});

/** Import config fresh against the current process.env. */
async function loadConfig() {
  const mod = await import("@/lib/config");
  return mod.default;
}

describe("app URL resolution", () => {
  it("prefers an explicit public NEXT_PUBLIC_APP_URL", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://genhub.co.tz/";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "something-else.vercel.app";

    const config = await loadConfig();
    expect(config.appUrl).toBe("https://genhub.co.tz"); // trailing slash stripped
    expect(config.appUrlSource).toBe("NEXT_PUBLIC_APP_URL");
  });

  it("falls back to the Vercel production domain when the variable is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "genhub.co.tz";

    const config = await loadConfig();
    expect(config.appUrl).toBe("https://genhub.co.tz");
    expect(config.appUrlSource).toBe("VERCEL_PROJECT_PRODUCTION_URL");
  });

  it("ignores a localhost value on a hosted deployment and uses the platform URL", async () => {
    // The realistic mistake: .env.local is copied to the dashboard unchanged.
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "genhub.co.tz";

    const config = await loadConfig();
    expect(config.appUrl).toBe("https://genhub.co.tz");
    expect(config.appUrlSource).toBe("VERCEL_PROJECT_PRODUCTION_URL");
  });

  it("uses the per-deployment URL for preview deployments", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = "genhub-git-pr-42.vercel.app";

    const config = await loadConfig();
    expect(config.appUrl).toBe("https://genhub-git-pr-42.vercel.app");
    expect(config.appUrlSource).toBe("VERCEL_URL");
  });

  it("stays on localhost when nothing is configured", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

    const config = await loadConfig();
    expect(config.appUrl).toBe("http://localhost:3000");
    expect(config.appUrlSource).toBe("localhost");
  });

  it("warns in production whenever the URL was not set explicitly", async () => {
    mutableEnv.NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "genhub.co.tz";

    const { default: config, productionConfigWarnings } = await import(
      "@/lib/config"
    );

    const warnings = productionConfigWarnings();
    expect(
      warnings.some((w) => w.includes("inferred from VERCEL_PROJECT_PRODUCTION_URL"))
    ).toBe(true);
    // The inferred URL is still usable, so it must not be reported as localhost
    expect(warnings.some((w) => w.includes("still localhost"))).toBe(false);
    expect(config.appUrl).toBe("https://genhub.co.tz");
  });

  it("warns in production when the URL really is localhost", async () => {
    mutableEnv.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

    const { productionConfigWarnings } = await import("@/lib/config");

    expect(
      productionConfigWarnings().some((w) =>
        w.includes("app URL is still localhost")
      )
    ).toBe(true);
  });
});
