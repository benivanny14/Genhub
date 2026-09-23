// =============================================================================
// GENHUB - Cron authorization
//
// Locks in the fix for a real leak: two of the four cron routes accepted the
// secret as `?secret=` in the query string. Query strings are written to access
// logs, proxy logs and CDN logs, so a secret that authorizes MOVING MONEY
// (releasing creator earnings into a withdrawable balance, charging subscriber
// cards) would be retained somewhere other than the server's environment, where
// anyone with log access could replay it. Neither scheduler needs that form:
// Vercel Cron sends `Authorization: Bearer`, the GitHub Actions workflow sends
// `x-cron-secret`.
//
// The four routes had also drifted into two different rule sets (some read
// config.cron.secret, some process.env; some accepted the query param, some did
// not), and all four compared with `!==`, which is not constant-time.
//
// Asserted here:
//   1. a correct secret in either header is accepted
//   2. a wrong/absent secret is rejected
//   3. `?secret=` is rejected even when correct — and says why
//   4. the comparison is constant-time (hashed, equal-length buffers)
//   5. an unset CRON_SECRET fails CLOSED in production but stays usable in dev
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const STRONG = "a3f1".repeat(16); // 64 hex chars, stands in for CRON_SECRET

async function loadGuard(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const mod = await import("@/lib/cron-auth");
    return mod.requireCronSecret;
  } finally {
    process.env = saved;
    vi.resetModules();
  }
}

function request(opts: {
  headers?: Record<string, string>;
  query?: string;
}): NextRequest {
  return new NextRequest(`http://localhost:3000/api/cron/release-earnings${opts.query ?? ""}`, {
    method: "POST",
    headers: opts.headers ?? {},
  });
}

afterEach(() => vi.resetModules());

describe("requireCronSecret", () => {
  it("accepts the secret as an Authorization: Bearer header (Vercel Cron)", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    expect(guard(request({ headers: { authorization: `Bearer ${STRONG}` } }))).toBeNull();
  });

  it("accepts the secret as x-cron-secret (GitHub Actions workflow)", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    expect(guard(request({ headers: { "x-cron-secret": STRONG } }))).toBeNull();
  });

  it("accepts a lowercase bearer scheme", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    expect(guard(request({ headers: { authorization: `bearer ${STRONG}` } }))).toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    const denied = guard(request({ headers: { "x-cron-secret": "wrong" } }));
    expect(denied?.status).toBe(401);
  });

  it("rejects a missing secret", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    expect(guard(request({}))?.status).toBe(401);
  });

  // The whole point of this change: a correct secret in the URL is still denied.
  it("rejects the secret in the query string even when it is correct, and explains why", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    const denied = guard(request({ query: `?secret=${STRONG}` }));

    expect(denied?.status).toBe(401);
    return denied!.json().then((body) => {
      expect(body.error).toMatch(/query string/i);
    });
  });

  it("does not accept a length-prefix of the real secret (no substring match)", async () => {
    const guard = await loadGuard({ CRON_SECRET: STRONG, NODE_ENV: "production" });
    expect(guard(request({ headers: { "x-cron-secret": STRONG.slice(0, 32) } }))?.status).toBe(401);
    expect(guard(request({ headers: { "x-cron-secret": STRONG + "extra" } }))?.status).toBe(401);
  });

  it("compares via hashed, equal-length buffers so the compare is constant-time", async () => {
    // Reading the implementation is the only way to assert this from outside:
    // a plain `===` on different-length strings returns early and leaks length.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/cron-auth.ts", "utf8")
    );
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("createHash");
    // And it must NOT fall back to a naive comparison anywhere.
    expect(source).not.toMatch(/provided\s*===\s*expected/);
  });

  it("fails closed in production when CRON_SECRET is unset", async () => {
    const guard = await loadGuard({ CRON_SECRET: undefined, NODE_ENV: "production" });
    const denied = guard(request({ headers: { "x-cron-secret": STRONG } }));
    expect(denied?.status).toBe(401);
    return denied!.json().then((body) => {
      expect(body.error).toMatch(/CRON_SECRET is not configured/);
    });
  });

  it("stays usable outside production with no secret, so local cron needs no setup", async () => {
    const guard = await loadGuard({ CRON_SECRET: undefined, NODE_ENV: "development" });
    expect(guard(request({}))).toBeNull();
  });
});
