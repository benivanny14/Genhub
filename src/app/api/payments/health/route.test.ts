// =============================================================================
// GENHUB - GET /api/payments/health (ClickPesa)
//
// ClickPesa exposes no balance/float endpoint, so this route answers a different
// question than it used to: are the credentials and the webhook verification in
// place, and are recent charges settling? These tests pin the two states that
// matter to an operator — ready for live, and not ready with a reason.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  checksumKey: "" as string,
  webhookToken: "" as string,
  clientId: "IDF5OPn" as string,
  apiKey: "SKGkey" as string,
  sandbox: false,
}));

vi.mock("@/lib/config", () => ({
  default: {
    appUrl: "https://genhub.test",
    appUrlSource: "NEXT_PUBLIC_APP_URL",
    nodeEnv: "test",
    get clickPesa() {
      return {
        clientId: state.clientId,
        apiKey: state.apiKey,
        baseUrl: "https://api.clickpesa.com/third-parties",
        webhookToken: state.webhookToken,
        checksumKey: state.checksumKey,
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
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireRole: async () => ({ userId: "admin-1", role: "ADMIN" }),
  AuthError: class AuthError extends Error {
    statusCode = 403;
  },
}));

vi.mock("@/lib/payments/clickpesa", () => ({
  clickpesaGatewayState: () => ({ open: false, openUntil: 0, failures: 0, skipped: 0 }),
  clickpesaBreakerNotice: () => null,
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
  state.checksumKey = "";
  state.webhookToken = "";
  state.clientId = "IDF5OPn";
  state.apiKey = "SKGkey";
  state.sandbox = false;
});

describe("GET /api/payments/health — ClickPesa readiness", () => {
  it("is ready for live with credentials and a checksum key", async () => {
    state.checksumKey = "checksum-secret";

    const data = await body();

    expect(data.gateway).toBe("CLICKPESA");
    expect(data.readyForLive).toBe(true);
    expect(data.checks.apiKey!.ok).toBe(true);
    expect(data.checks.webhookVerification!.value).toContain("checksum");
  });

  it("accepts a shared webhook token as webhook verification", async () => {
    state.webhookToken = "a-long-shared-token";

    const data = await body();

    expect(data.readyForLive).toBe(true);
    expect(data.checks.webhookVerification!.value).toContain("shared token");
  });

  it("is NOT ready when the credentials are missing", async () => {
    state.checksumKey = "checksum-secret";
    state.apiKey = "";

    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.apiKey!.ok).toBe(false);
  });

  it("is NOT ready when no webhook secret is configured", async () => {
    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.webhookVerification!.ok).toBe(false);
  });

  it("is NOT ready in sandbox mode, whatever else is set", async () => {
    state.checksumKey = "checksum-secret";
    state.sandbox = true;

    const data = await body();

    expect(data.readyForLive).toBe(false);
    expect(data.checks.sandboxMode!.ok).toBe(false);
  });
});
