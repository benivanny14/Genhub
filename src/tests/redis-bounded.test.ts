// =============================================================================
// GENHUB - The bound on every Redis call
//
// Redis sits on the payment path: a settlement awaits `cacheDel`, so a backend
// that accepts the connection and then never answers used to add seconds to
// every charge. That is not a slow test — it is a customer whose payment stayed
// pending, and on a serverless function it is a settlement killed by the
// function timeout halfway through.
//
// Found the honest way: the deploy gates went red on GitHub with two payment
// tests timing out at 15s, and they passed on a laptop. The difference was a
// local Redis on 6379. Point the clone at a dead one and the two tests fail
// locally in exactly the same way — which is what the last test here pins.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedCaller } from "@/lib/redis";

/** A promise that never settles — an unreachable backend, not a failing one. */
const never = () => new Promise<never>(() => {});

describe("createBoundedCaller", () => {
  it("returns the value when the backend answers", async () => {
    const caller = createBoundedCaller({ timeoutMs: 100 });
    expect(await caller.run(async () => "pong")).toEqual({ ok: true, value: "pong" });
    expect(caller.state().failures).toBe(0);
  });

  it("abandons a call that never answers, and says why", async () => {
    const caller = createBoundedCaller({ timeoutMs: 50 });
    const started = Date.now();

    const outcome = await caller.run(never);

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("tells a thrown error apart from a timeout", async () => {
    const caller = createBoundedCaller({ timeoutMs: 100 });
    const outcome = await caller.run(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(outcome).toEqual({ ok: false, reason: "error" });
  });

  it("stops trying at all once the backend has failed twice in a row", async () => {
    // The whole point: one dead backend must not cost every later call the same
    // wait. This is the difference between a suite that fails and a suite that
    // finishes.
    const caller = createBoundedCaller({ timeoutMs: 20, failuresToOpen: 2, openForMs: 60_000 });
    const op = vi.fn(never);

    await caller.run(op);
    await caller.run(op);
    expect(caller.state().failures).toBe(2);

    const skipped = await caller.run(op);
    expect(skipped).toEqual({ ok: false, reason: "open" });
    // Never attempted: the counter proves it, rather than the timing.
    expect(op).toHaveBeenCalledTimes(2);
    expect(caller.state().skipped).toBe(1);
  });

  it("tries again once the breaker's window has passed", async () => {
    let clock = 1_000;
    const caller = createBoundedCaller({
      timeoutMs: 20,
      failuresToOpen: 1,
      openForMs: 5_000,
      now: () => clock,
    });

    await caller.run(never);
    expect(await caller.run(async () => "x")).toEqual({ ok: false, reason: "open" });

    clock += 5_001;
    expect(await caller.run(async () => "recovered")).toEqual({ ok: true, value: "recovered" });
    expect(caller.state().failures).toBe(0);
  });

  it("does not let one failure open the breaker on its own", async () => {
    const caller = createBoundedCaller({ timeoutMs: 20, failuresToOpen: 2, openForMs: 5_000 });

    await caller.run(never);
    // Still closed: a single blip is not an outage.
    expect(await caller.run(async () => "ok")).toEqual({ ok: true, value: "ok" });
  });

  it("survives the backend settling after it gave up", async () => {
    // A late rejection must not surface as an unhandled rejection minutes later.
    const caller = createBoundedCaller({ timeoutMs: 10 });
    let rejectLate: (error: Error) => void = () => {};
    const late = new Promise<never>((_, reject) => {
      rejectLate = reject;
    });

    expect(await caller.run(() => late)).toEqual({ ok: false, reason: "timeout" });
    rejectLate(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("the data path actually uses it", () => {
  const source = readFileSync(join(process.cwd(), "src", "lib", "redis.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("bounds every cache and rate-limit call", () => {
    for (const helper of ["cacheGet", "cacheSet", "cacheDel", "checkRateLimit"]) {
      const start = code.indexOf(`export async function ${helper}`);
      expect(start, `${helper} not found`).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf("\n}", start));
      expect(body, `${helper} must go through the bounded caller`).toContain("dataCall.run(");
    }
  });

  it("has exactly one unbounded backend call, and it is the probe", () => {
    // Verification is the deliberate exception: `verifyRedisWritable` answers an
    // admin asking "does Redis work?", and reporting an unreachable backend as
    // healthy would be worse than being slow. Everything a request touches goes
    // through the caller.
    // Plain exec loop rather than matchAll: this project compiles to a target
    // where iterating a RegExpStringIterator needs --downlevelIteration.
    const pattern = /await redisBackend\./g;
    const direct: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) direct.push(match.index);
    expect(direct).toHaveLength(1);

    const probe = code.indexOf("export async function verifyRedisWritable");
    const probeBody = code.slice(probe, code.indexOf("\n}", probe));
    expect(probeBody).toContain("await redisBackend.");
  });
});
