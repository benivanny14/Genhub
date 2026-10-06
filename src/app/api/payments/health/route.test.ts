// =============================================================================
// GENHUB - GET /api/payments/health (SonicPesa)
//
// SonicPesa exposes no balance/float endpoint, so this route answers a different
// question than it used to: are the credentials and the webhook verification in
// place, and are recent charges settling? These tests pin the two states that
// matter to an operator — ready for live, and not ready with a reason.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  secretKey: "" as string,
  webhookToken: "" as string,
  accessKey: "sk_live_test" as string,
  sandbox: false,
}));

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    appUrlSource: "NEXT_PUBLIC_APP_URL",
    nodeEnv: "test",
    get sonicPesa() {
      return {
        accessKey: state.accessKey,
        secretKey: state.secretKey,
        baseUrl: "https://api.sonicpesa.com/api/v1",
        webhookToken: state.webhookToken,
        fallbackEmail: "payments@genhub.app",
        sandbox: state.sandbox,
      };
    },
  },
}));

vi.mock("@/lib/db", () => ({
  default: {
    transaction: {
      count: async () => 0,
      findFirst: async () => null,
      // The account-fault scan reads recent FAILED rows and classifies each
      // gatewayError; an empty page is the healthy case.
      findMany: async () => [],
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: async () => ({ userId: "admin-1", role: "ADMIN" }),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/payments/sonicpesa", () => ({
  sonicpesaGatewayState: () => ({ open: false, openUntil: 0, failures: 0, skipped: 0 }),
  sonicpesaBreakerNotice: () => null,
}));

import { GET } from "@/app/api/payments/health/route";

async function body() {
  return (await (await GET()).json()).data as {
    readyForLive: boolean;
    gateway: string;
    checks: Record<string, { ok: boolean; value: unknown }>;
  };
}

beforeEach(() => {
  state.secretKey = "";
  state.webhookToken = "";
  state.accessKey = "sk_live_test";
  state.sandbox = false;
});

describe("GET /api/payments/health — SonicPesa readiness", () => {
  it("is ready for live with credentials and a secret key", async () => {
    state.secretKey = "secret-key-value";

    const data = await body();

    expect(data.gateway).toBe("SONICPESA");
    expect(data.readyForLive).toBe(true);
    expect(data.checks.accessKey!.ok).toBe(true);
    expect(data.checks.webhookVerification!.value).toContain("signature");
  });

  it("accepts a shared webhook token as webhook verification", async () => {
    state.webhookToken = "a-long-shared-token";

    const data = await body();

    expect(data.readyForLive).toBe(true);
    expect(data.checks.webhookVerification!.value).toContain("shared token");
  });

  it("is NOT ready when the credentials are missing", async () => {
    state.secretKey = "secret-key-value";
    state.accessKey = "";

    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.accessKey!.ok).toBe(false);
  });

  it("is NOT ready when no webhook secret is configured", async () => {
    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.webhookVerification!.ok).toBe(false);
  });

  it("is NOT ready in sandbox mode, whatever else is set", async () => {
    state.secretKey = "secret-key-value";
    state.sandbox = true;

    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.sandboxMode!.ok).toBe(false);
  });
});
