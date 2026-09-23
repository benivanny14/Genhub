// =============================================================================
// GENHUB - A webhook that cannot be verified must not be acted on
//
// The HarakaPay callback used to read:
//
//     if (config.harakaPay.webhookToken && token !== config.harakaPay.webhookToken)
//
// so with no token configured the entire comparison was skipped. Anyone could
// POST `{ order_id, status: "completed" }` for a checkout they had started
// themselves and be handed the paid content, with the creator credited for
// money nobody paid. The deployment gate (scripts/verify-env.mjs) refuses a
// production build without a token, which is why this had not gone off yet —
// but a single gate is not the same as a route that is safe by construction.
//
// Two things are checked here, and they are different:
//
//   * the decision table itself (pure, no server, every branch)
//   * that the route is actually wired to it — a correct helper that the route
//     never calls is the failure mode this file exists to prevent
//
// The accepting path (a verified callback actually settling) is covered where
// it belongs, against a real database: harakapay.e2e.test.ts.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

// The route reads its configuration once, at import time. Mocking it is what
// lets these tests put a deployment into the state that matters — no token, in
// production — which cannot otherwise be arranged from inside a test.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, any> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      nodeEnv: "production",
      harakaPay: { ...actual.default.harakaPay, webhookToken: "" },
    },
  };
});

import config from "@/lib/config";
import { verifyWebhookToken } from "@/lib/webhook-auth";
import { secretMatches } from "@/lib/shared-secret";
import { POST as webhookPost } from "@/app/api/webhooks/harakapay/route";

const TOKEN = "c1f4e9a7b3d85f2069a1c7e4b8d3f5061a2b3c4d5e6f708192a3b4c5d6e7f809";

/** Flip the mocked configuration the route sees. */
function setToken(token: string) {
  (config.harakaPay as { webhookToken: string }).webhookToken = token;
}

afterEach(() => setToken(""));

describe("verifyWebhookToken", () => {
  const check = (provided: string, configured: string, nodeEnv = "production") =>
    verifyWebhookToken({ provided, configured, nodeEnv });

  it("accepts the configured token", () => {
    expect(check(TOKEN, TOKEN)).toEqual({ ok: true });
  });

  it("rejects a different token", () => {
    expect(check("not-the-token", TOKEN)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects an empty token when one is configured", () => {
    expect(check("", TOKEN)).toEqual({ ok: false, reason: "mismatch" });
  });

  // The behaviour change. "We have no token" must never mean "anyone may call".
  it("refuses a callback in production when no token is configured", () => {
    expect(check("", "")).toEqual({ ok: false, reason: "not-configured" });
    // Even a caller who guesses that the deployment is unconfigured and sends
    // something cannot be accepted.
    expect(check("anything", "")).toEqual({ ok: false, reason: "not-configured" });
  });

  // ...but local work needs no token, exactly like the cron routes.
  it.each(["development", "test"])("still allows an unconfigured %s run", (nodeEnv) => {
    expect(check("", "", nodeEnv)).toEqual({ ok: true });
  });

  it("does not treat a configured-but-empty pair as a match", () => {
    // Guards the trap in the old condition from the other side: it is not
    // enough to fail closed in production, the token must never compare equal
    // to nothing anywhere.
    expect(check("", "")).not.toEqual({ ok: true });
  });
});

describe("secretMatches", () => {
  it("matches identical secrets", () => {
    expect(secretMatches(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a secret that differs in the last character", () => {
    // The `!==` this replaced also returned false here; the point is that the
    // constant-time version must not be weaker.
    expect(secretMatches(`${TOKEN.slice(0, -1)}0`, TOKEN)).toBe(false);
  });

  it("rejects secrets of different lengths without throwing", () => {
    // A bare timingSafeEqual throws on unequal lengths, and that throw would
    // itself leak the secret's length.
    expect(() => secretMatches("short", TOKEN)).not.toThrow();
    expect(secretMatches("short", TOKEN)).toBe(false);
  });

  it("never matches when either side is empty", () => {
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("", TOKEN)).toBe(false);
    expect(secretMatches(TOKEN, "")).toBe(false);
  });
});

describe("the route uses it", () => {
  /**
   * A body that is not JSON at all, on purpose.
   *
   * The guard runs before `request.json()`, so a 401 here proves the request
   * was refused rather than merely mishandled — if the check were skipped, the
   * unparseable body would fall into the catch-all and answer 200 (which is
   * what the route does on error, so the gateway stops retrying).
   */
  function call(token?: string) {
    const url = `http://localhost/api/webhooks/harakapay${token === undefined ? "" : `?t=${encodeURIComponent(token)}`}`;
    return webhookPost(
      new NextRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not json",
      })
    );
  }

  it("refuses an unverifiable callback even though the body is unusable", async () => {
    setToken("");
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("refuses a callback carrying the wrong token", async () => {
    setToken(TOKEN);
    const res = await call("WRONG");
    expect(res.status).toBe(401);
  });

  it("refuses a callback carrying no token at all when one is configured", async () => {
    setToken(TOKEN);
    const res = await call();
    expect(res.status).toBe(401);
  });
});
