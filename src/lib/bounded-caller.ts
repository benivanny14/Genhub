// =============================================================================
// GENHUB - A caller that gives up, and then stops trying for a while
//
// Extracted from lib/redis.ts, which needed it first, now that a second
// provider does: the HarakaPay gateway. Nothing here is Redis-specific — the
// shape it tames is any dependency that accepts the connection and then never
// answers, and the two things a caller needs from it are the same everywhere:
//
//   * a bound, so one slow call cannot hold a request open until the function
//     timeout, and
//   * a breaker, because one dead dependency is not one slow call — it is every
//     call for the rest of the process's life, each paying the wait again.
//
// Pure: no clock, no network, no globals — so every branch is covered in
// src/tests/bounded-caller.test.ts and src/tests/harakapay-bounded.test.ts
// without waiting on real time.
// =============================================================================

/** Marker for "the dependency did not answer in time", so it is not an unexpected throw. */
const TIMED_OUT = Symbol("bounded-call-timed-out");

/** Reject after `ms` without leaving the provider's own promise unhandled. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The call may still settle later. Swallow it here, or a late rejection
      // surfaces as an unhandled rejection long after the request moved on.
      promise.catch(() => {});
      reject(TIMED_OUT);
    }, ms);
    // Never keep the process alive for a call nobody is waiting on any more.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type BoundedOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error" | "open" };

export interface BoundedCallerOptions {
  /** How long one call may take before it is abandoned. */
  timeoutMs?: number;
  /** How long the breaker stays open after `failuresToOpen` failures in a row. */
  openForMs?: number;
  /** Failures in a row before calls stop being attempted at all. */
  failuresToOpen?: number;
  /** Injectable clock, so the breaker is testable without waiting. */
  now?: () => number;
  /**
   * Whether a thrown error should count toward opening the breaker.
   *
   * Defaults to counting everything. A provider whose errors include legitimate
   * *business* rejections — a bad phone number, a declined charge — passes a
   * predicate here, so one customer's mistake can never open the breaker for
   * everybody. A non-counting error also clears the streak: the provider plainly
   * answered, so the next call deserves a fresh attempt.
   */
  countsAsFailure?: (error: unknown) => boolean;
}

/**
 * A caller that bounds every call, and stops attempting a dependency that keeps
 * failing.
 *
 * The breaker matters as much as the timeout. One unreachable backend is not one
 * slow call — it is every call for the rest of the process's life, each paying
 * the connect-and-retry cycle again. A payment that touches the cache three
 * times would pay it three times; a reconcile sweep pays it once per pending
 * charge; a suite of thirty files pays it hundreds.
 */
export function createBoundedCaller(options: BoundedCallerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 750;
  const openForMs = options.openForMs ?? 15_000;
  const failuresToOpen = options.failuresToOpen ?? 2;
  const now = options.now ?? (() => Date.now());
  const countsAsFailure = options.countsAsFailure ?? (() => true);

  let openUntil = 0;
  let failures = 0;
  let attempted = 0;
  let skipped = 0;

  return {
    async run<T>(op: () => Promise<T>): Promise<BoundedOutcome<T>> {
      if (now() < openUntil) {
        skipped += 1;
        return { ok: false, reason: "open" };
      }

      attempted += 1;
      try {
        const value = await withTimeout(op(), timeoutMs);
        failures = 0;
        return { ok: true, value };
      } catch (error) {
        const timedOut = error === TIMED_OUT;
        if (timedOut || countsAsFailure(error)) {
          failures += 1;
          if (failures >= failuresToOpen) openUntil = now() + openForMs;
        } else {
          // The dependency answered — this request failed, but not because it is
          // unreachable, so it is not evidence for the breaker. Clear the streak
          // so a stale failure count cannot trip it on the next real blip.
          failures = 0;
        }
        return { ok: false, reason: timedOut ? "timeout" : "error" };
      }
    },
    /** For the admin report and for tests. */
    state: () => ({ openUntil, failures, attempted, skipped }),
  };
}
