// =============================================================================
// GENHUB - The bound on every HarakaPay gateway call
//
// The gateway used to have a per-call timeout and nothing else, which is half
// the fix. `harakaStatus` is called in a loop by the reconcile sweep — once per
// pending charge — so a gateway that accepts the connection and then never
// answers turned one sweep into minutes of sequential 20s waits, and the
// checkout poll into a spinner that never moved.
//
// So the gateway gets the same treatment Redis did (src/tests/redis-bounded.test.ts):
// a bound, plus a breaker that stops attempting it for a while. The one thing
// that is different is stated as a test below — a 4xx is the gateway *working*,
// so it must not count toward opening the breaker. Otherwise one customer's
// typo, twice, would pause payments for everybody.
//
// Each test imports the module fresh (vi.resetModules) so the breaker starts
// closed; it is process-global by design, not per-call.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const harakaPay = vi.hoisted(() => ({
  apiKey: "test-key",
  baseUrl: "https://harakapay.test",
  webhookToken: "test-webhook-token",
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, harakaPay } };
});

/** A fresh module instance, so each test starts with a closed breaker. */
async function gateway() {
  vi.resetModules();
  return import("@/lib/payments/harakapay");
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HarakaPay calls are bounded", () => {
  it("abandons a gateway that never answers, and names the wait", async () => {
    const { harakaStatus } = await gateway();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => {})));
    vi.useFakeTimers();

    const pending = harakaStatus("HP1");
    const rejected = expect(pending).rejects.toThrow(/timed out after 20s/);

    // The caller's own bound, not the OS socket timeout: nothing else would
    // settle this promise, so it is the 20s bound that has to reject it.
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
  });

  it("keeps the gateway's own 4xx message and never trips the breaker on it", async () => {
    const { harakaCollect, harakaGatewayState } = await gateway();
    const fetchMock = vi.fn(async () =>
      json({ success: false, error: "Invalid mobile number." }, 400)
    );
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 3; i++) {
      await expect(
        harakaCollect({ phone: "0700000000", amount: 1000 })
      ).rejects.toThrow("Invalid mobile number.");
    }

    // Every call reached the gateway, and none of them counted as a fault: the
    // gateway answered, it just said no.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(harakaGatewayState().failures).toBe(0);
    expect(harakaGatewayState().openUntil).toBe(0);
  });

  it("opens the breaker on repeated 5xx and refuses the next call without sending it", async () => {
    const { harakaStatus, harakaGatewayState } = await gateway();
    const fetchMock = vi.fn(async () => json({ error: "upstream error" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(harakaStatus("HP1")).rejects.toThrow("upstream error");
    await expect(harakaStatus("HP2")).rejects.toThrow("upstream error");

    await expect(harakaStatus("HP3")).rejects.toThrow(/was not sent/);

    // The point of the breaker: the third call cost nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harakaGatewayState().skipped).toBe(1);
  });

  it("counts a transport failure as a fault and keeps its message", async () => {
    const { harakaBalance, harakaGatewayState } = await gateway();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    await expect(harakaBalance()).rejects.toThrow("ECONNREFUSED");
    expect(harakaGatewayState().failures).toBe(1);
  });

  it("describes an open breaker without blaming the API key", async () => {
    const { harakaBreakerNotice } = await gateway();

    // Closed is the normal state, and the two surfaces that show this must stay
    // silent rather than print "breaker: closed" on a healthy deploy.
    expect(harakaBreakerNotice({ open: false, openUntil: 0, failures: 0 }, 1_000)).toBeNull();

    const notice = harakaBreakerNotice({ open: true, openUntil: 31_000, failures: 2 }, 1_000);
    expect(notice).toContain("skipping gateway calls");
    expect(notice).toContain("30s");
    // The sentence that stops someone hunting for a bad key that is fine.
    expect(notice).toContain("API key is not the problem");
  });

  it("resumes once the window passes, and one success closes it", async () => {
    const { harakaStatus, harakaGatewayState } = await gateway();
    vi.useFakeTimers();

    let healthy = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        healthy
          ? json({ success: true, payment: { order_id: "HP1", status: "completed" } }, 200)
          : json({ error: "upstream error" }, 503)
      )
    );

    await expect(harakaStatus("HP1")).rejects.toThrow();
    await expect(harakaStatus("HP2")).rejects.toThrow();
    expect(harakaGatewayState().openUntil).toBeGreaterThan(0);
    expect(harakaGatewayState().failures).toBe(2);

    healthy = true;
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(harakaStatus("HP3")).resolves.toMatchObject({ success: true });
    expect(harakaGatewayState().failures).toBe(0);
  });
});
