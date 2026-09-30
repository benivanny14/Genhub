// =============================================================================
// GENHUB - Request hardening
//
// Three properties that were added to close a real gap and must not regress:
//
//   1. FAIL-CLOSED RATE LIMITING. A shared-store outage must refuse the
//      security-critical routes rather than downgrade them to per-instance
//      memory, which is how a limiter becomes `instances × max` attempts. The
//      bounded caller is stubbed to fail, so this pins the DEGRADE path itself.
//   2. TRUSTED IP. A client must not be able to choose its own rate-limit key by
//      prepending to `x-forwarded-for`.
//   3. BOUNDED RAW BODIES. The HMAC webhook has to hold the raw bytes before it
//      can verify them, so the cap has to come BEFORE the read.
// =============================================================================

import { describe, it, expect, vi } from "vitest";

// The data path is forced to fail, which is exactly what an unreachable Redis
// looks like to every caller. The real checkRateLimit/checkRateLimitStrict then
// run their degrade branches.
vi.mock("@/lib/bounded-caller", () => ({
  createBoundedCaller: () => ({
    run: async () => ({ ok: false, reason: "error" }),
    state: () => ({ open: false, openUntil: 0, failures: 1, attempted: 1, skipped: 0 }),
  }),
}));

import { checkRateLimit, checkRateLimitStrict } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { readRawBodyCapped, MAX_BUNNY_WEBHOOK_BODY_BYTES } from "@/lib/request-body";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("rate limiting when the shared store is unreachable", () => {
  it("checkRateLimit degrades to per-instance memory and SAYS so", async () => {
    const result = await checkRateLimit(`degrade-${Date.now()}`, 5, 60_000);

    // Still enforced locally, but flagged — the flag is what lets a security
    // route refuse instead of quietly accepting a weaker bound.
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it("checkRateLimitStrict fails CLOSED instead of downgrading", async () => {
    const result = await checkRateLimitStrict(`strict-${Date.now()}`, 5, 60_000);

    expect(result.degraded).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.allowed).toBe(false);
  });
});

describe("clientIp never trusts a client-supplied leading hop", () => {
  const headers = (map: Record<string, string>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  it("takes the LAST x-forwarded-for hop (the one the proxy appended)", () => {
    // An attacker can prepend anything; the closest proxy appends the real one.
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe(
      "203.0.113.9"
    );
  });

  it("prefers x-real-ip when the platform sets it", () => {
    expect(
      clientIp(headers({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" }))
    ).toBe("198.51.100.7");
  });

  it("returns one documented shared key when there is no header at all", () => {
    expect(clientIp(headers({}))).toBe("unknown");
    expect(clientIp(undefined)).toBe("unknown");
  });
});

describe("readRawBodyCapped bounds the HMAC webhook before it buffers", () => {
  it("refuses an oversized declared Content-Length without reading", async () => {
    const fake = {
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? "999999" : null) },
      body: null,
      text: async () => "should never be read",
    } as unknown as Request;

    const result = await readRawBodyCapped(fake, MAX_BUNNY_WEBHOOK_BODY_BYTES);
    expect(result.ok).toBe(false);
  });

  it("abandons a chunked body the moment it passes the cap", async () => {
    const fake = {
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
          controller.close();
        },
      }),
    } as unknown as Request;

    expect((await readRawBodyCapped(fake, 10)).ok).toBe(false);
    // A body inside the cap still comes back intact.
    const small = {
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
    } as unknown as Request;
    const ok = await readRawBodyCapped(small, 10);
    expect(ok).toEqual({ ok: true, text: "hello" });
  });
});

describe("the security-critical routes actually use the fail-closed limiter", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  const strictRoutes = [
    "src/app/api/auth/login/route.ts",
    "src/app/api/auth/register/route.ts",
    "src/app/api/auth/forgot-password/route.ts",
    "src/app/api/auth/reset-password/route.ts",
    "src/app/api/payments/purchase/route.ts",
    "src/app/api/payments/topup/route.ts",
    "src/app/api/payments/status/[orderId]/route.ts",
  ];

  for (const route of strictRoutes) {
    it(`${route} fails closed on a shared-store outage`, () => {
      const src = read(route);
      expect(src).toContain("checkRateLimitStrict");
      expect(src).toContain("unavailable");
    });
  }

  const publicRoutes = [
    "src/app/api/home-feed/route.ts",
    "src/app/api/videos/route.ts",
    "src/app/api/creators/route.ts",
    "src/app/api/media/[...path]/route.ts",
    "src/app/api/videos/[id]/stream/route.ts",
    "src/app/api/videos/[id]/intro/route.ts",
    "src/app/api/videos/[id]/intro-clip/route.ts",
    "src/app/api/videos/status/route.ts",
  ];

  for (const route of publicRoutes) {
    it(`${route} is rate-limited`, () => {
      expect(read(route)).toContain("checkRateLimit(");
    });
  }

  it("the Bunny webhook caps the raw body before buffering it", () => {
    const src = read("src/app/api/webhooks/bunny/route.ts");
    expect(src).toContain("readRawBodyCapped");
    expect(src).toContain("MAX_BUNNY_WEBHOOK_BODY_BYTES");
  });
});
