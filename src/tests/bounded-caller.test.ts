// =============================================================================
// GENHUB - Failure classification for the bounded caller
//
// The caller itself is covered by src/tests/redis-bounded.test.ts. What is new
// here is `countsAsFailure`: the option that lets a provider whose errors
// include legitimate business rejections keep those out of the breaker.
//
// Why it matters, in one sentence: without it, one customer typing a bad phone
// number twice would pause payments for everybody, because the gateway answered
// — it just said no.
// =============================================================================

import { describe, it, expect } from "vitest";
import { createBoundedCaller } from "@/lib/bounded-caller";

describe("countsAsFailure", () => {
  it("counts every error by default, so existing callers are unchanged", async () => {
    const caller = createBoundedCaller({ timeoutMs: 50, failuresToOpen: 1, openForMs: 60_000 });

    await caller.run(async () => {
      throw new Error("boom");
    });

    // One real failure is enough to open, as before.
    expect(await caller.run(async () => "x")).toEqual({ ok: false, reason: "open" });
  });

  it("does not open the breaker on an error the predicate rejects", async () => {
    class BusinessError extends Error {}
    const caller = createBoundedCaller({
      timeoutMs: 50,
      failuresToOpen: 2,
      openForMs: 60_000,
      countsAsFailure: (error) => !(error instanceof BusinessError),
    });

    for (let i = 0; i < 3; i++) {
      const outcome = await caller.run(async () => {
        throw new BusinessError("bad phone number");
      });
      expect(outcome).toEqual({ ok: false, reason: "error" });
    }

    // Still closed, and the next call is attempted rather than refused.
    expect(caller.state().failures).toBe(0);
    expect(await caller.run(async () => "ok")).toEqual({ ok: true, value: "ok" });
  });

  it("still opens on a counting error that follows a business one", async () => {
    class BusinessError extends Error {}
    const caller = createBoundedCaller({
      timeoutMs: 50,
      failuresToOpen: 1,
      openForMs: 60_000,
      countsAsFailure: (error) => !(error instanceof BusinessError),
    });

    await caller.run(async () => {
      throw new BusinessError("nope");
    });
    // A business error proves the provider is reachable, so the streak is clean…
    expect(caller.state().failures).toBe(0);

    // …and the next real fault is what opens the breaker.
    await caller.run(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await caller.run(async () => "x")).toEqual({ ok: false, reason: "open" });
  });

  it("never lets a timeout be excused by the predicate", async () => {
    // A hang is exactly the failure the breaker exists for, so it is counted
    // regardless of what the predicate says about errors.
    const caller = createBoundedCaller({
      timeoutMs: 10,
      failuresToOpen: 1,
      openForMs: 60_000,
      countsAsFailure: () => false,
    });

    expect(await caller.run(() => new Promise<never>(() => {}))).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await caller.run(async () => "x")).toEqual({ ok: false, reason: "open" });
  });
});
