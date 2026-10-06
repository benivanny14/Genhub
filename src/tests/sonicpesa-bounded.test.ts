// =============================================================================
// GENHUB - The bound on every SonicPesa gateway call
//
// The gateway has a per-call timeout AND a breaker. `sonicpesaStatus` is called
// in a loop by the reconcile sweep — once per pending charge — so a gateway that
// accepts the connection and then never answers would turn one sweep into
// minutes of sequential 20s waits, and the checkout poll into a spinner that
// never moved.
//
// So the gateway gets the same treatment Redis did (src/tests/redis-bounded.test.ts):
// a bound, plus a breaker that stops attempting it for a while. The one thing
// that is different is stated as a test below — a 4xx is the gateway *working*,
// so it must not count toward opening the breaker. Otherwise one customer's
// typo, twice, would pause payments for everybody.
//
// Each test imports the module fresh (vi.resetModules) so the breaker starts
// closed; it is process-global by design, not per-call. Auth is a static header,
// so there is no token to seed — the calls go straight to the endpoint.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const sonicPesa = vi.hoisted(() => ({
  accessKey: "test-key",
  secretKey: "test-secret",
  baseUrl: "https://sonicpesa.test/api/v1",
  webhookToken: "test-webhook-token",
  fallbackEmail: "payments@test.local",
  sandbox: false,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, sonicPesa } };
});

/** A fresh module instance, so each test starts with a closed breaker. */
async function gateway() {
  vi.resetModules();
  return import("@/lib/payments/sonicpesa");
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SonicPesa calls are bounded", () => {
  it("abandons a gateway that never answers, and names the wait", async () => {
    const { sonicpesaStatus } = await gateway();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => {})));
    vi.useFakeTimers();

    const pending = sonicpesaStatus("CP1");
    const rejected = expect(pending).rejects.toThrow(/timed out after 20s/);

    // The caller's own bound, not the OS socket timeout: nothing else would
    // settle this promise, so it is the 20s bound that has to reject it.
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
  });

  it("keeps the gateway's own 4xx message and never trips the breaker on it", async () => {
    const { sonicpesaCollect, sonicpesaGatewayState } = await gateway();
    const fetchMock = vi.fn(async () =>
      json({ message: "Invalid / unsupported phone number" }, 400)
    );
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 3; i++) {
      await expect(
        sonicpesaCollect({
          phone: "255700000000",
          amount: 1000,
          orderReference: `CP${i}`,
        })
      ).rejects.toThrow("Invalid / unsupported phone number");
    }

    // Every call reached the gateway, and none of them counted as a fault: the
    // gateway answered, it just said no.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sonicpesaGatewayState().failures).toBe(0);
    expect(sonicpesaGatewayState().openUntil).toBe(0);
  });

  it("opens the breaker on repeated 5xx and refuses the next call without sending it", async () => {
    const { sonicpesaStatus, sonicpesaGatewayState } = await gateway();
    const fetchMock = vi.fn(async () => json({ message: "upstream error" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sonicpesaStatus("CP1")).rejects.toThrow("upstream error");
    await expect(sonicpesaStatus("CP2")).rejects.toThrow("upstream error");

    await expect(sonicpesaStatus("CP3")).rejects.toThrow(/was not sent/);

    // The point of the breaker: the third call cost nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sonicpesaGatewayState().skipped).toBe(1);
  });

  it("counts a transport failure as a fault and keeps its message", async () => {
    const { sonicpesaStatus, sonicpesaGatewayState } = await gateway();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    await expect(sonicpesaStatus("CP1")).rejects.toThrow("ECONNREFUSED");
    expect(sonicpesaGatewayState().failures).toBe(1);
  });

  it("describes an open breaker without blaming the credentials", async () => {
    const { sonicpesaBreakerNotice } = await gateway();

    // Closed is the normal state, and the surfaces that show this must stay
    // silent rather than print "breaker: closed" on a healthy deploy.
    expect(sonicpesaBreakerNotice({ open: false, openUntil: 0, failures: 0 }, 1_000)).toBeNull();

    const notice = sonicpesaBreakerNotice({ open: true, openUntil: 31_000, failures: 2 }, 1_000);
    expect(notice).toContain("skipping gateway calls");
    expect(notice).toContain("30s");
    // The sentence that stops someone hunting for bad credentials that are fine.
    expect(notice).toContain("credentials are not the problem");
  });

  it("resumes once the window passes, and one success closes it", async () => {
    const { sonicpesaStatus, sonicpesaGatewayState } = await gateway();
    vi.useFakeTimers();

    let healthy = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        healthy
          ? json([{ orderReference: "CP1", status: "SUCCESS" }], 200)
          : json({ message: "upstream error" }, 503)
      )
    );

    await expect(sonicpesaStatus("CP1")).rejects.toThrow();
    await expect(sonicpesaStatus("CP2")).rejects.toThrow();
    expect(sonicpesaGatewayState().openUntil).toBeGreaterThan(0);
    expect(sonicpesaGatewayState().failures).toBe(2);

    healthy = true;
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(sonicpesaStatus("CP3")).resolves.toMatchObject({ success: true });
    expect(sonicpesaGatewayState().failures).toBe(0);
  });
});
