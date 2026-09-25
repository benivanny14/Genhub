// =============================================================================
// GENHUB - The float gate: refusing a collect that could never be delivered
//
// HarakaPay settles a USSD prompt out of a PREPAID FLOAT on the merchant
// account. At 0 the gateway does not refuse: it accepts the collect, answers
// "USSD push sent", and never delivers the prompt. The customer was told it
// worked, their phone never rang, and the order sat PENDING forever — so the fix
// is to know the state before asking, not after.
//
// These tests pin the three decisions the guard makes, because each one is a way
// of getting it wrong that costs real money:
//
//   1. BLOCK AT ZERO ONLY. The alarm floor (TZS 10,000) is where an operator
//      wants to be warned; the gateway still delivers prompts above zero, so
//      refusing there would lose sales the float could have paid for.
//   2. FAIL OPEN WHEN THE BALANCE IS UNREADABLE. "We could not read it" is not
//      "it is empty", and refusing every payment on a balance endpoint that is
//      down would turn a gateway blip into an outage of our own making.
//   3. ONE READING A MINUTE. The gate sits on the checkout path, so a busy minute
//      must cost one balance call, not one per customer.
//
// The gateway module is imported fresh per test (the breaker is process-global by
// design) and `fetch` is stubbed, so nothing here can reach a real gateway.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const harakaPay = vi.hoisted(() => ({
  apiKey: "test-key",
  baseUrl: "https://harakapay.test",
  webhookToken: "test-webhook-token",
  sandbox: false,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, harakaPay } };
});

// A cache that lives only inside this mock, plus the handles the tests need to
// tell "read the gateway" from "reuse the reading", and to emulate the entry
// expiring. The point of the third decision is exactly that difference.
const cache = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  return {
    store,
    ttls,
    clear: () => {
      store.clear();
      ttls.length = 0;
    },
    /** The TTL the gate asked for on its last write, in seconds. */
    lastTtl: () => ttls[ttls.length - 1],
  };
});

vi.mock("@/lib/redis", () => ({
  cacheGet: async (key: string) => {
    const raw = cache.store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  cacheSet: async (key: string, value: unknown, ttlSeconds: number) => {
    cache.store.set(key, JSON.stringify(value));
    cache.ttls.push(ttlSeconds);
  },
}));

/** A fresh module instance, so each test starts with a closed breaker. */
async function gateway() {
  vi.resetModules();
  return import("@/lib/payments/harakapay");
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * A gateway that answers the balance with `float` and a collect with an order.
 * Returns the paths that were actually hit, so a test can assert on both the
 * count and the route — "no collect was sent" is the claim that matters most.
 */
function gatewayFetch(float: number | null, opts: { balanceFails?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));

      if (String(url).includes("/balance")) {
        if (opts.balanceFails) throw new Error("ECONNREFUSED");
        return json({ success: true, wallet_balance: 0, float_balance: float });
      }

      return json({ success: true, order_id: "HP_COLLECTED", message: "USSD push sent to phone" });
    })
  );

  return {
    calls,
    balanceCalls: () => calls.filter((c) => c.includes("/balance")).length,
    collectCalls: () => calls.filter((c) => c.includes("/collect")).length,
  };
}

const request = { phone: "0712345678", amount: 1_000 };

beforeEach(() => {
  harakaPay.apiKey = "test-key";
  harakaPay.sandbox = false;
  cache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The decision, from a number
// ---------------------------------------------------------------------------

describe("floatGateState", () => {
  it("refuses at zero and below, sells above it", async () => {
    const { floatGateState } = await gateway();

    expect(floatGateState(0)).toBe("empty");
    // A gateway reporting a negative float after a correction is reporting the
    // same thing: nothing in it to pay for a prompt.
    expect(floatGateState(-250)).toBe("empty");
    expect(floatGateState(1)).toBe("ok");
    expect(floatGateState(10_000)).toBe("ok");
  });

  it("never calls an unreadable balance 'empty'", async () => {
    const { floatGateState } = await gateway();

    // Each of these is a state where the honest answer is "we do not know", and
    // the only safe thing to do with that answer is to let the sale continue.
    expect(floatGateState(null)).toBe("unknown");
    expect(floatGateState(undefined)).toBe("unknown");
    expect(floatGateState(Number.NaN)).toBe("unknown");
    expect(floatGateState(Number.POSITIVE_INFINITY)).toBe("unknown");
    expect(floatGateState("nonsense" as unknown as number)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 2. The refusal: nothing is sent, and the customer is told the truth
// ---------------------------------------------------------------------------

describe("harakaCollect and an empty float", () => {
  it("refuses without ever asking the gateway to charge the phone", async () => {
    const { harakaCollect, HarakaFloatEmptyError, FLOAT_EMPTY_CUSTOMER_MESSAGE } =
      await gateway();
    const gatewayCalls = gatewayFetch(0);

    await expect(harakaCollect(request)).rejects.toBeInstanceOf(HarakaFloatEmptyError);
    await expect(harakaCollect(request)).rejects.toMatchObject({
      code: "GATEWAY_FLOAT_EMPTY",
      // 503, not 502: the gateway is healthy, we are temporarily unable to sell.
      status: 503,
      floatTzs: 0,
    });
    // The sentence the customer reads is the sentence support reads back to them.
    await expect(harakaCollect(request)).rejects.toThrow(FLOAT_EMPTY_CUSTOMER_MESSAGE);

    // The whole point: balance readings only, and not one collect. A charge
    // accepted here would have been one nobody could deliver.
    expect(gatewayCalls.collectCalls()).toBe(0);
    expect(gatewayCalls.calls[0]).toContain("/api/v1/balance");
  });

  it("treats a negative float exactly like zero", async () => {
    const { harakaCollect } = await gateway();
    gatewayFetch(-100);

    await expect(harakaCollect(request)).rejects.toThrow(/NOT been charged/);
  });

  it("sells normally when the float can pay for a prompt", async () => {
    const { harakaCollect, floatGate } = await gateway();
    const gatewayCalls = gatewayFetch(5_000);

    const response = await harakaCollect(request);

    expect(response.order_id).toBe("HP_COLLECTED");
    expect(gatewayCalls.collectCalls()).toBe(1);
    expect(await floatGate()).toMatchObject({ state: "ok", floatTzs: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Failing open — a balance we cannot read is not an empty float
// ---------------------------------------------------------------------------

describe("when the float cannot be read", () => {
  it("attempts the collect and reports the state as unknown", async () => {
    const { harakaCollect, floatGate } = await gateway();
    const gatewayCalls = gatewayFetch(null, { balanceFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await harakaCollect(request);

    // The sale goes through. Refusing a payment that may be perfectly payable,
    // because of a reading we could not take, is the worse of the two errors —
    // and the collect itself is the authoritative test.
    expect(response.order_id).toBe("HP_COLLECTED");
    expect(gatewayCalls.collectCalls()).toBe(1);

    // Never silent: the state is a fact with a name, not a shrug.
    expect(await floatGate()).toMatchObject({ state: "unknown", floatTzs: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[Float Gate]"));
    warn.mockRestore();
  });

  it("treats a gateway answer with no float in it as unknown, not empty", async () => {
    const { floatGate } = await gateway();
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: true, wallet_balance: 20_000 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await floatGate()).toMatchObject({ state: "unknown", floatTzs: null });
    warn.mockRestore();
  });

  it("does not cost a balance call per checkout while the answer is unreadable", async () => {
    const { harakaCollect } = await gateway();
    const gatewayCalls = gatewayFetch(null, { balanceFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // One customer a minute is one reading; a broken balance endpoint must not
    // also become one gateway call per checkout.
    for (let i = 0; i < 3; i++) await harakaCollect(request);

    expect(gatewayCalls.balanceCalls()).toBe(1);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. One reading a minute, and recovery with nothing to restart
// ---------------------------------------------------------------------------

describe("the reading is cached", () => {
  it("pays for one balance call a minute, not one per customer", async () => {
    const { harakaCollect } = await gateway();
    const gatewayCalls = gatewayFetch(0);

    for (let i = 0; i < 3; i++) {
      await expect(harakaCollect(request)).rejects.toThrow(/NOT been charged/);
    }

    expect(gatewayCalls.balanceCalls()).toBe(1);
    expect(gatewayCalls.collectCalls()).toBe(0);
    // Cached for a minute, which is why a topped-up float brings sales back on
    // its own: no cache to clear and nothing to redeploy.
    expect(cache.lastTtl()).toBe(60);
  });

  it("starts selling again as soon as the cached reading expires", async () => {
    const { harakaCollect, floatGate } = await gateway();

    // Down: the refusal comes from a reading that is now cached.
    gatewayFetch(0);
    await expect(harakaCollect(request)).rejects.toThrow(/NOT been charged/);
    expect(await floatGate()).toMatchObject({ state: "empty", cached: true });

    // The float is topped up and the entry expires (FLOAT_CACHE_MS) — the same
    // module, the same process, no restart and no key touched.
    cache.clear();
    const toppedUp = gatewayFetch(25_000);

    const response = await harakaCollect(request);

    expect(response.order_id).toBe("HP_COLLECTED");
    expect(toppedUp.collectCalls()).toBe(1);
    expect(await floatGate()).toMatchObject({ state: "ok", floatTzs: 25_000 });
  });
});

// ---------------------------------------------------------------------------
// 5. Sandbox: the guard must not reach for the network where no push is sent
// ---------------------------------------------------------------------------

describe("sandbox mode", () => {
  it("does not consult the gateway at all", async () => {
    harakaPay.sandbox = true;
    const { floatGate, floatGateApplies } = await gateway();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(floatGateApplies()).toBe(false);
    expect(await floatGate()).toMatchObject({ state: "ok", floatTzs: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not gate when there is no API key to call with", async () => {
    const { floatGateApplies } = await gateway();
    harakaPay.apiKey = "";

    // No key means no live push is possible, so there is no float to ask about —
    // and the collect itself fails with its own, accurate error.
    expect(floatGateApplies()).toBe(false);
  });
});
