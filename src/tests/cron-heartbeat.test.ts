// =============================================================================
// GENHUB - Background job heartbeats
//
// This feature exists to notice silence, so the tests have to answer two
// questions the feature itself cannot get wrong:
//
//   1. Does it tell "stopped running" apart from "has nothing to do"? Those two
//      look identical from outside — no request arrives either way — and only
//      one of them is a problem. Getting it backwards means either an alarm
//      that never fires (the bug this was built for) or one that always does
//      (which is how alarms get ignored).
//   2. Can a worker be added that reports nothing? A missing heartbeat reads as
//      "never ran", which is the safe direction, but only if the schedule is
//      driven by a route that records one. So the routes are scanned here, not
//      trusted.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import prisma from "@/lib/db";
import {
  CRON_WORKERS,
  classifyWorker,
  getCronHealth,
  runCronJob,
  summarizeCronHealth,
  type CronWorkerDef,
} from "@/lib/services/cron-heartbeat.service";

/** Poll until `check` passes, so a test can wait on a claim instead of sleeping. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

const WORKER = "poll-encoding" as const;

/**
 * Clear the whole table, not just this file's worker.
 *
 * Several cases below are about the *absence* of a heartbeat ("never ran"), so
 * they only mean something on a table with no rows. Rows left by a running dev
 * server — or by an earlier test file — made them fail, which is a test that
 * passes or fails depending on what else has been running.
 *
 * Safe to delete: this table holds nothing but liveness metadata, and every
 * worker rewrites its own row on its next run.
 *
 * No database, no clearing: the sections above are pure functions and file
 * reads, and they run whether or not one is configured (setup-env.ts drops
 * DATABASE_URL when it points at a live database).
 */
async function clearHeartbeats() {
  if (!process.env.DATABASE_URL) return;
  await prisma.cronHeartbeat.deleteMany();
}

beforeEach(clearHeartbeats);
afterEach(clearHeartbeats);

/**
 * The sections that touch a real database. Everything above them is a pure
 * function or a source file, so it still runs when there is no database to
 * point at — which is what setup-env.ts does rather than let a test run write
 * to the database real users are on.
 */
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

// -----------------------------------------------------------------------------
// 1. The registry is the only place a cadence is defined, so it has to be sane
// -----------------------------------------------------------------------------

describe("worker registry", () => {
  it("gives every worker a cadence and a stale budget above it", () => {
    expect(CRON_WORKERS.length).toBeGreaterThan(0);

    for (const w of CRON_WORKERS) {
      expect(w.everyMinutes).toBeGreaterThan(0);
      // A budget at or below the cadence would flag a worker as overdue simply
      // for running exactly when it should.
      expect(w.staleAfterMinutes).toBeGreaterThan(w.everyMinutes);
      expect(w.consequence.length).toBeGreaterThan(0);
      expect(w.schedule.length).toBeGreaterThan(0);
    }
  });

  it("keeps the in-flight grace far below the stale budget", () => {
    // These jobs finish in seconds, so the two windows answer different
    // questions and must not collapse into one: the stale budget is "may have
    // been skipped", the grace is "can still plausibly be working".
    for (const w of CRON_WORKERS) {
      expect(w.inFlightGraceMinutes).toBeGreaterThan(0);
      expect(w.inFlightGraceMinutes).toBeLessThan(w.staleAfterMinutes);
    }
  });

  it("does not list the same worker twice", () => {
    const ids = CRON_WORKERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags exactly the worker that can reach a customer's phone", () => {
    // renew-subscriptions falls back to a USSD push, so a manual run of it can
    // send a real charge request to a real fan. That single fact is what makes
    // the admin panel ask for confirmation — if it is ever set on another
    // worker, the confirmation starts appearing where it is not needed; if it
    // is ever dropped from this one, a click starts sending charge requests.
    expect(CRON_WORKERS.filter((w) => w.sendsCustomerRequests).map((w) => w.id)).toEqual([
      "renew-subscriptions",
    ]);
  });

  // The promise made in the service header: a cron route cannot be added that
  // silently reports nothing, and a worker cannot be registered that nothing
  // calls. Both failures read as "never ran" forever, which is a false alarm
  // nobody would know how to clear.
  //
  // Routes no longer hold the job themselves — they hand the worker id to the
  // shared runner, which is where the lock and the heartbeat live. So the same
  // guarantee is checked at both levels: a route cannot do work without going
  // through the runner, and the runner cannot leave a registered worker with no
  // job behind it.
  it("covers every cron route, and no route reports an unregistered worker", () => {
    const dir = join(process.cwd(), "src", "app", "api", "cron");
    const routes = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, code: readFileSync(join(dir, e.name, "route.ts"), "utf8") }));

    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      expect(
        route.code.includes("runWorkerNow("),
        `${route.name} does not run through runWorkerNow() — its work would run with no lock and no heartbeat`
      ).toBe(true);
      expect(
        route.code.includes('requireCronSecret(request)'),
        `${route.name} does not check the cron secret`
      ).toBe(true);
    }

    const runner = readFileSync(
      join(process.cwd(), "src", "lib", "services", "cron-jobs.service.ts"),
      "utf8"
    );

    const reported = new Set<string>();
    // Plain exec loop rather than matchAll: this project compiles to a target
    // where iterating a RegExpStringIterator needs --downlevelIteration.
    const pattern = /runCronJob\(\s*"([a-z-]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(runner)) !== null) {
      expect(
        CRON_WORKERS.some((w) => w.id === match![1]),
        `the job runner records unknown worker "${match[1]}"`
      ).toBe(true);
      reported.add(match[1]);
    }

    for (const w of CRON_WORKERS) {
      expect(
        reported.has(w.id),
        `no job is wired to "${w.id}" — the dashboard could show it, but nothing could run it`
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// 2. The classification rule
//
// Written as a table because every row is a real situation. The two that matter
// most are the last two: a long job must not be mistaken for a stopped one, and
// a job killed mid-flight must not be mistaken for a healthy one.
// -----------------------------------------------------------------------------

describe("classifyWorker", () => {
  const def: CronWorkerDef = {
    id: "reconcile-payments",
    name: "test",
    consequence: "test",
    everyMinutes: 10,
    staleAfterMinutes: 40,
    inFlightGraceMinutes: 5,
    schedule: "test",
    sendsCustomerRequests: false,
  };
  const now = new Date("2026-09-23T12:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("reports a worker with no heartbeat as never, and names where to look", () => {
    const v = classifyWorker(def, null, now);
    expect(v.state).toBe("never");
    expect(v.ageMinutes).toBeNull();
    expect(v.unfinishedRun).toBe(false);
    expect(v.detail).toContain(def.schedule);
  });

  it("reports a recent successful run as ok", () => {
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(3),
        lastFinishedAt: ago(3),
        lastOutcome: "OK",
        lastError: null,
      },
      now
    );
    expect(v.state).toBe("ok");
    expect(v.ageMinutes).toBe(3);
  });

  it("reports silence past the budget as late, and keeps the reason", () => {
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(90),
        lastFinishedAt: ago(90),
        lastOutcome: "OK",
        lastError: null,
      },
      now
    );
    expect(v.state).toBe("late");
    expect(v.detail).toContain("stopped firing");
  });

  it("tolerates one late run — exactly at the budget is not yet overdue", () => {
    // Started and finished a while back, so the run is complete: this isolates
    // the stale budget from the in-flight grace.
    const beat = {
      lastStartedAt: ago(60),
      lastFinishedAt: ago(def.staleAfterMinutes),
      lastOutcome: "OK",
      lastError: null,
    };
    expect(classifyWorker(def, beat, now).state).toBe("ok");
    expect(
      classifyWorker(def, { ...beat, lastFinishedAt: ago(def.staleAfterMinutes + 1) }, now).state
    ).toBe("late");
  });

  it("does not call a dead run \"running\" however recent its start", () => {
    // The bug this test was written from: a start 40 minutes ago was reported
    // as "running" because the in-flight window was the stale budget. A run that
    // open is dead, and "running" is the one answer that stops anyone looking.
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(def.staleAfterMinutes),
        lastFinishedAt: ago(def.staleAfterMinutes + 1),
        lastOutcome: "OK",
        lastError: null,
      },
      now
    );
    expect(v.state).toBe("stalled");
  });

  it("reports a run killed mid-job as stalled, not as a stopped schedule", () => {
    // Different fix: the scheduler is fine, the job dies when it runs.
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(180),
        lastFinishedAt: ago(190),
        lastOutcome: "OK",
        lastError: null,
      },
      now
    );
    expect(v.state).toBe("stalled");
    expect(v.unfinishedRun).toBe(true);
    expect(v.detail).toContain("never finished");
  });

  it("reports a run that finished recently but failed as failing, with the error", () => {
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(5),
        lastFinishedAt: ago(4),
        lastOutcome: "ERROR",
        lastError: "gateway timeout",
      },
      now
    );
    expect(v.state).toBe("failing");
    expect(v.detail).toContain("gateway timeout");
  });

  it("prefers late over failing when both are true", () => {
    // Nothing has run for hours AND the last attempt failed. "Nothing is
    // running" is the louder fact — fixing the error alone would not help.
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(200),
        lastFinishedAt: ago(200),
        lastOutcome: "ERROR",
        lastError: "gateway timeout",
      },
      now
    );
    expect(v.state).toBe("late");
  });

  it("treats a fresh unfinished run as running, not as a missing worker", () => {
    // The whole point of stamping the start: a job that legitimately takes
    // minutes must not page anyone.
    const v = classifyWorker(
      def,
      {
        lastStartedAt: ago(1),
        lastFinishedAt: ago(11),
        lastOutcome: "OK",
        lastError: null,
      },
      now
    );
    expect(v.state).toBe("running");
    expect(v.unfinishedRun).toBe(true);
  });

  it("handles a first run that started and has not finished yet", () => {
    // No finish at all, and the start is inside the grace: running.
    const v = classifyWorker(
      def,
      { lastStartedAt: ago(2), lastFinishedAt: null, lastOutcome: null, lastError: null },
      now
    );
    expect(v.state).toBe("running");

    // Same shape, but the start never came back — the very first run died, so
    // there is no successful run to hide behind.
    expect(
      classifyWorker(
        def,
        { lastStartedAt: ago(120), lastFinishedAt: null, lastOutcome: null, lastError: null },
        now
      ).state
    ).toBe("stalled");
  });

  it("treats the in-flight grace boundary as still running", () => {
    const beat = {
      lastStartedAt: ago(def.inFlightGraceMinutes),
      lastFinishedAt: ago(def.inFlightGraceMinutes + 10),
      lastOutcome: "OK",
      lastError: null,
    };
    expect(classifyWorker(def, beat, now).state).toBe("running");
    expect(
      classifyWorker(def, { ...beat, lastStartedAt: ago(def.inFlightGraceMinutes + 1) }, now).state
    ).toBe("stalled");
  });
});

// -----------------------------------------------------------------------------
// 2b. The wording
//
// These strings are the entire output an operator sees, and they are assembled
// from a duration helper — the first live run produced "for 3 h ago" and
// "30 min ago ago", which is how a real status line turns into noise nobody
// finishes reading.
// -----------------------------------------------------------------------------

describe("worker detail phrasing", () => {
  const def: CronWorkerDef = {
    id: "reconcile-payments",
    name: "test",
    consequence: "test",
    everyMinutes: 10,
    staleAfterMinutes: 40,
    inFlightGraceMinutes: 5,
    schedule: "test",
    sendsCustomerRequests: false,
  };
  const now = new Date("2026-09-23T12:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  const detailsFor = [
    classifyWorker(def, null, now),
    classifyWorker(
      def,
      { lastStartedAt: ago(1), lastFinishedAt: ago(11), lastOutcome: "OK", lastError: null },
      now
    ),
    classifyWorker(
      def,
      { lastStartedAt: ago(200), lastFinishedAt: ago(200), lastOutcome: "OK", lastError: null },
      now
    ),
    classifyWorker(
      def,
      { lastStartedAt: ago(30), lastFinishedAt: ago(75), lastOutcome: "OK", lastError: null },
      now
    ),
    classifyWorker(
      def,
      { lastStartedAt: ago(6), lastFinishedAt: ago(5), lastOutcome: "ERROR", lastError: "boom" },
      now
    ),
    classifyWorker(
      def,
      { lastStartedAt: ago(5), lastFinishedAt: ago(4), lastOutcome: "OK", lastError: null },
      now
    ),
  ];

  it("never doubles a preposition", () => {
    for (const v of detailsFor) {
      expect(v.detail).not.toMatch(/ago ago/);
      // A duration helper that hard-codes "ago" produces "for 2 h ago".
      expect(v.detail).not.toMatch(/\bfor\b[^.]*\bago\b/);
    }
  });

  it("says something useful in every state", () => {
    for (const v of detailsFor) {
      expect(v.detail.length).toBeGreaterThan(20);
      expect(v.detail.trim()).toBe(v.detail);
    }
  });

  it("names the schedule when nothing is calling the worker", () => {
    expect(detailsFor[0].detail).toContain("test");
  });
});

// -----------------------------------------------------------------------------
// 3. Recording, against the real database
// -----------------------------------------------------------------------------

describeDb("runCronJob", () => {
  it("returns the result and records a success summary", async () => {
    const outcome = await runCronJob(
      WORKER,
      async () => ({ checked: 7, published: 3, failed: 0 }),
      (r) => `${r.checked} checked, ${r.published} published`
    );

    expect(outcome.ran).toBe(true);
    expect(outcome.ran && outcome.result.published).toBe(3);
    expect(outcome.ran && outcome.summary).toBe("7 checked, 3 published");

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(row?.lastOutcome).toBe("OK");
    expect(row?.lastSummary).toBe("7 checked, 3 published");
    expect(row?.lastError).toBeNull();
    expect(row?.runsTotal).toBe(1);
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastFinishedAt).not.toBeNull();
    expect(row?.lastDurationMs).toBeGreaterThanOrEqual(0);
    // The lock is not left behind: the next trigger must be free to run.
    expect(row?.runLockedAt).toBeNull();
  });

  it("records where a run came from, so a manual run does not look scheduled", async () => {
    // The heartbeat is the only record of which runs a person started. A manual
    // run that is indistinguishable from a scheduled one makes the dashboard
    // say "running on schedule" about something no schedule did.
    await runCronJob(WORKER, async () => "ok", () => "did the thing", "manual run from the admin panel");

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(row?.lastSummary).toBe("did the thing (manual run from the admin panel)");
  });

  it("records a failure, counts it, and still throws", async () => {
    await expect(
      runCronJob(WORKER, async () => {
        throw new Error("bunny unreachable");
      })
    ).rejects.toThrow("bunny unreachable");

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(row?.lastOutcome).toBe("ERROR");
    expect(row?.lastError).toBe("bunny unreachable");
    expect(row?.consecutiveFailures).toBe(1);
    // A job that dies must not leave the worker locked out of its next run.
    expect(row?.runLockedAt).toBeNull();
  });

  it("escalates consecutive failures and clears them on the next success", async () => {
    for (let i = 1; i <= 3; i++) {
      await expect(
        runCronJob(WORKER, async () => {
          throw new Error("still down");
        })
      ).rejects.toThrow();
      const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
      expect(row?.consecutiveFailures).toBe(i);
      expect(row?.runsTotal).toBe(i);
    }

    await runCronJob(WORKER, async () => "recovered");

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    // The count means "failing right now", not "has ever failed".
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.runsTotal).toBe(4);
    expect(row?.lastOutcome).toBe("OK");
  });

  it("keeps the job's own result when the heartbeat cannot be written", async () => {
    // A heartbeat table that is unreachable must not take down a worker that
    // moves money. It degrades to a warning; the staleness is itself visible.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(prisma.cronHeartbeat, "upsert")
      .mockRejectedValue(new Error("db down") as never);

    try {
      const outcome = await runCronJob(WORKER, async () => "money moved");
      expect(outcome.ran && outcome.result).toBe("money moved");
      expect(warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------------
// 3b. The run lock
//
// Two schedulers can be configured at once (the docs describe Vercel Cron and
// GitHub Actions both), and the admin panel can start a worker by hand. For
// renew-subscriptions a double run is not a duplicated log line — it is a
// second USSD charge on a real person's phone. So the guard has to hold for
// concurrent callers, not just for a double click.
// -----------------------------------------------------------------------------

describeDb("the run lock", () => {
  it("refuses a second trigger while a run is in flight", async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRun = resolve));

    const first = runCronJob(WORKER, async () => {
      await gate;
      return "first";
    });

    // Wait for the claim, not for a fixed sleep: the assertion below is only
    // about what happens once the lock is held.
    await waitFor(async () => {
      const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
      return row?.runLockedAt != null;
    });

    const second = await runCronJob(WORKER, async () => "second");
    expect(second.ran).toBe(false);
    expect(second.ran === false && second.reason).toContain("skipped");

    // The refused trigger must not have touched the record: a run that never
    // happened must not look like one that did.
    const during = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(during?.runsTotal).toBe(0);
    expect(during?.lastOutcome).toBeNull();

    releaseRun();
    const done = await first;
    expect(done.ran && done.result).toBe("first");

    const after = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(after?.runLockedAt).toBeNull();
    expect(after?.runsTotal).toBe(1);
  });

  it("allows the next run once the first one returns", async () => {
    const first = await runCronJob(WORKER, async () => "one");
    const second = await runCronJob(WORKER, async () => "two");

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
    expect(second.ran && second.result).toBe("two");
  });

  it("refuses while a lock inside its grace is held, even with no process behind it", async () => {
    // A worker whose run was killed by a function timeout leaves the lock
    // behind. Until it expires the trigger is refused, and — the part that
    // matters — nothing is written that claims a run happened.
    await prisma.cronHeartbeat.create({
      data: { worker: WORKER, lastStartedAt: new Date(), runLockedAt: new Date() },
    });

    const outcome = await runCronJob(WORKER, async () => "should not run");
    expect(outcome.ran).toBe(false);

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(row?.runsTotal).toBe(0);
    expect(row?.lastOutcome).toBeNull();
    expect(row?.lastFinishedAt).toBeNull();
  });

  it("expires a lock whose run never came back, so the worker recovers on its own", async () => {
    // The alternative — a lock with no expiry — turns one timed-out run into a
    // worker that never runs again, which is the failure this whole feature
    // exists to make visible.
    const longAgo = new Date(Date.now() - 40 * 60_000);
    await prisma.cronHeartbeat.create({
      data: { worker: WORKER, lastStartedAt: longAgo, runLockedAt: longAgo },
    });

    // And the dashboard reports it as a killed run, not as "running".
    const health = await getCronHealth();
    expect(health.workers.find((w) => w.id === WORKER)?.state).toBe("stalled");

    const outcome = await runCronJob(WORKER, async () => "after the dead run");
    expect(outcome.ran).toBe(true);
    expect(outcome.ran && outcome.result).toBe("after the dead run");
  });

  it("claims a completely new worker without a pre-existing row", async () => {
    // The claim is an UPDATE that expects a row; a worker that has never run has
    // none, so the first-ever run must still be able to start.
    const outcome = await runCronJob(WORKER, async () => "first ever");
    expect(outcome.ran).toBe(true);

    const row = await prisma.cronHeartbeat.findUnique({ where: { worker: WORKER } });
    expect(row?.runsTotal).toBe(1);
    expect(row?.lastStartedAt).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 4. What the dashboard and the monitor are told
// -----------------------------------------------------------------------------

describeDb("getCronHealth", () => {
  it("reports every registered worker, including ones with no heartbeat", async () => {
    const health = await getCronHealth();

    expect(health.workers.map((w) => w.id).sort()).toEqual(CRON_WORKERS.map((w) => w.id).sort());
    expect(health.counts.never).toBe(CRON_WORKERS.length);
    // A schedule that was never configured is setup work, not a regression.
    expect(health.degraded).toBe(false);
    expect(health.alerting).toBe(0);
  });

  it("carries the consequence and the schedule so the card can explain itself", async () => {
    const health = await getCronHealth();
    const worker = health.workers.find((w) => w.id === "release-earnings")!;

    expect(worker.consequence).toContain("holding period");
    expect(worker.schedule.length).toBeGreaterThan(0);
  });

  it("goes degraded once a worker that had been running falls silent", async () => {
    await prisma.cronHeartbeat.create({
      data: {
        worker: WORKER,
        lastStartedAt: new Date(Date.now() - 3 * 60 * 60_000),
        lastFinishedAt: new Date(Date.now() - 3 * 60 * 60_000),
        lastOutcome: "OK",
        runsTotal: 12,
      },
    });

    const health = await getCronHealth();
    expect(health.counts.late).toBe(1);
    expect(health.degraded).toBe(true);
    expect(health.alerting).toBe(1);

    // And the monitor sees the same thing the dashboard does.
    expect(summarizeCronHealth(health)).toBe("late");
  });

  it("surfaces a never-run worker in the health verdict without degrading the app", async () => {
    const health = await getCronHealth();
    // Three of four have never run: still not an outage, but not "ok" either.
    expect(summarizeCronHealth(health)).toBe("never");
    expect(health.degraded).toBe(false);
  });

  it("reports ok only when every worker is inside its cadence", async () => {
    // Also guarded below: the route must be uncached, or none of this reaches a
    // monitor. See the /api/health block.

    for (const w of CRON_WORKERS) {
      await prisma.cronHeartbeat.create({
        data: {
          worker: w.id,
          lastStartedAt: new Date(),
          lastFinishedAt: new Date(),
          lastOutcome: "OK",
          runsTotal: 1,
        },
      });
    }

    const health = await getCronHealth();
    expect(health.counts.ok).toBe(CRON_WORKERS.length);
    expect(summarizeCronHealth(health)).toBe("ok");
    expect(health.degraded).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 5. The health route has to be uncached
//
// Found while adding this feature: /api/health read no cookies or headers, so
// Next prerendered it — the build output marked it `o` (static) while the other
// 69 API routes were `f` (dynamic). In production it would have answered from a
// build-time snapshot forever, so an uptime monitor would never once have seen
// the truth. Asserted from the source because that is where the flag lives.
// -----------------------------------------------------------------------------

describe("/api/health caching", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "app", "api", "health", "route.ts"),
    "utf8"
  );

  it("is forced dynamic so the worker check is read live", () => {
    expect(source).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("reports the worker verdict a monitor can key on", () => {
    expect(source).toContain("summarizeCronHealth");
    expect(source).toContain("backgroundJobs");
  });
});
