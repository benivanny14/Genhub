// =============================================================================
// GENHUB - The cron supervisor
//
// GitHub Actions does not keep the intervals the worker workflows ask for, so
// each worker only ran when its own file happened to arrive. The supervisor is
// the answer: any poke runs every worker whose heartbeat is past its own budget.
//
// That makes this file the guard on two things a live run cannot be trusted to
// show, because both only bite occasionally:
//
//   1. What it refuses to run. `renew-subscriptions` can send a USSD charge
//      request to a fan's phone, so it is never started automatically — not when
//      it is late, not when the schedule has been dead for a week. A test that
//      let that regress would be silently sending charge requests.
//   2. What it counts as due. Running a worker that is `ok` is harmless; running
//      one that is `stalled` or `failing` repeats the same death; running one
//      that has `never` run papers over the setup work that needs doing.
//
// The decision is pure (`planSupervisorRuns`), so all of it is checked here
// without a database, a clock or a network — the same property `classifyWorker`
// and the watchdog's `shouldRecover` are built with.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CRON_WORKERS,
  type CronHealth,
  type CronWorkerHealth,
  type CronWorkerId,
  type CronWorkerState,
} from "@/lib/services/cron-heartbeat.service";
import {
  SUPERVISOR_WORKERS,
  planSupervisorRuns,
  snapshotSupervisorHealth,
  summarizeSupervisorRun,
  type SupervisorDecision,
  type SupervisorRunResult,
} from "@/lib/services/cron-supervisor.service";

// ---------------------------------------------------------------------------
// Fixtures: a health report built from the real registry, so the test breaks if
// a worker's `sendsCustomerRequests` flag moves rather than quietly drifting.
// ---------------------------------------------------------------------------

function worker(id: CronWorkerId, over: Partial<CronWorkerHealth> = {}): CronWorkerHealth {
  const def = CRON_WORKERS.find((w) => w.id === id)!;
  return {
    id: def.id,
    name: def.name,
    consequence: def.consequence,
    schedule: def.schedule,
    everyMinutes: def.everyMinutes,
    staleAfterMinutes: def.staleAfterMinutes,
    inFlightGraceMinutes: def.inFlightGraceMinutes,
    sendsCustomerRequests: def.sendsCustomerRequests,
    state: "ok",
    ageMinutes: 0,
    silentSince: null,
    silentForMinutes: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSummary: null,
    lastOrigin: null,
    lastError: null,
    lastDurationMs: null,
    consecutiveFailures: 0,
    runsTotal: 1,
    unfinishedRun: false,
    detail: `Last run succeeded less than a minute ago.`,
    ...over,
  };
}

/** A worker whose heartbeat is past its budget, silent for `minutes`. */
function late(id: CronWorkerId, minutes = 400): CronWorkerHealth {
  return worker(id, {
    state: "late",
    silentForMinutes: minutes,
    ageMinutes: minutes,
    silentSince: new Date(Date.now() - minutes * 60_000).toISOString(),
    detail: `Nothing has finished for ${Math.round(minutes / 60)} h (expected every 60 min). The schedule has stopped firing.`,
  });
}

function healthOf(workers: CronWorkerHealth[]): CronHealth {
  const counts: Record<CronWorkerState, number> = {
    never: 0,
    late: 0,
    stalled: 0,
    failing: 0,
    running: 0,
    ok: 0,
  };
  for (const w of workers) counts[w.state] += 1;
  const needing = workers.filter((w) => ["late", "stalled", "failing"].includes(w.state));

  return {
    workers,
    needsAttention: needing.map((w) => w.id),
    attentionSummary: "",
    counts,
    alerting: needing.length,
    degraded: needing.length > 0,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// What it runs
// ---------------------------------------------------------------------------

describe("planSupervisorRuns", () => {
  it("runs an overdue worker whose heartbeat is past its budget", () => {
    const plan = planSupervisorRuns(healthOf([late("release-earnings")]));

    expect(plan.run.map((d) => d.id)).toEqual(["release-earnings"]);
    expect(plan.held).toEqual([]);
    // The reason quoted is the heartbeat's own detail, so the log line says how
    // long it had been quiet rather than only that it was late.
    expect(plan.run[0].reason).toContain("Nothing has finished");
  });

  it("never runs the worker that can charge a customer's phone", () => {
    // The one rule that matters most. renew-subscriptions is overdue here by any
    // measure, and it still must not be started — a duplicate USSD charge on a
    // real handset is not recoverable, a missed renewal is.
    const plan = planSupervisorRuns(healthOf([late("renew-subscriptions", 1333)]));

    expect(plan.run).toEqual([]);
    expect(plan.held.map((d) => d.id)).toEqual(["renew-subscriptions"]);
    expect(plan.held[0].reason).toContain("customer's phone");
    expect(plan.held[0].reason).toContain("Admin → Background jobs");
  });

  it("runs the rest while holding that one, in one pass", () => {
    const plan = planSupervisorRuns(
      healthOf([
        late("release-earnings", 400),
        late("renew-subscriptions", 1333),
        late("poll-encoding", 47),
        late("reconcile-payments", 35),
      ])
    );

    expect(plan.run.map((d) => d.id)).toEqual(["release-earnings", "poll-encoding", "reconcile-payments"]);
    expect(plan.held.map((d) => d.id)).toEqual(["renew-subscriptions"]);
  });

  it("starts with the worker that has been quiet longest", () => {
    const plan = planSupervisorRuns(
      healthOf([late("poll-encoding", 47), late("release-earnings", 400), late("reconcile-payments", 35)])
    );

    expect(plan.run.map((d) => d.id)).toEqual(["release-earnings", "poll-encoding", "reconcile-payments"]);
  });

  it("leaves a healthy or working worker alone, without a sentence about it", () => {
    const plan = planSupervisorRuns(
      healthOf([
        worker("release-earnings", { state: "ok", silentForMinutes: 12 }),
        worker("reconcile-payments", { state: "running", silentForMinutes: 1 }),
      ])
    );

    expect(plan.run).toEqual([]);
    // Nothing to report: healthy workers are not "held", they need nothing. A
    // card that lists them is a card nobody reads.
    expect(plan.held).toEqual([]);
  });

  it("does not paper over a worker that has never run", () => {
    // `never` means no scheduler is wired up yet. Running it by hand here would
    // hide the one thing that needs doing — and the fix is a schedule, not a run.
    const plan = planSupervisorRuns(healthOf([worker("release-earnings", { state: "never" })]));

    expect(plan.run).toEqual([]);
    expect(plan.held[0].reason).toContain("never");
    expect(plan.held[0].reason).toContain("another run does not fix");
  });

  it.each(["stalled", "failing"] as const)(
    "does not repeat the same death for a %s worker",
    (state) => {
      // Both mean the job IS being triggered and dies when it runs, so starting
      // it again recovers nothing — it needs the crash fixed.
      const plan = planSupervisorRuns(healthOf([worker("poll-encoding", { state, detail: "boom" })]));

      expect(plan.run).toEqual([]);
      expect(plan.held[0].reason).toContain(state);
      expect(plan.held[0].reason).toContain("boom");
    }
  );

  it("reads a worker that does not say it can reach a phone as unsafe", () => {
    // Unknown must never mean "safe to start": a payload that omits the flag is
    // how a new customer-facing worker would slip through this guard.
    const silentAboutPhones = {
      ...late("release-earnings", 400),
      sendsCustomerRequests: undefined as unknown as boolean,
    };

    const plan = planSupervisorRuns(healthOf([silentAboutPhones]));

    expect(plan.run).toEqual([]);
    expect(plan.held[0].reason).toContain("customer's phone");
  });
});

// ---------------------------------------------------------------------------
// The two lists that must agree
// ---------------------------------------------------------------------------

describe("the workers the supervisor may start", () => {
  const startable = SUPERVISOR_WORKERS;
  const watchdogSource = readFileSync(
    join(process.cwd(), "scripts", "watchdog.mjs"),
    "utf8"
  );
  const match = watchdogSource.match(/export const RECOVERABLE_WORKERS = \[([^\]]*)\]/);
  const watchdogList = (match ? match[1] : "")
    .split(",")
    .map((s) => s.trim().replace(/["']/g, ""))
    .filter(Boolean);

  it("is the same list the uptime watchdog keeps", () => {
    // The app and the watchdog both decide "may I start this worker by itself",
    // and two copies of that answer is how one of them starts sending charges.
    expect(watchdogList.length).toBeGreaterThan(0);
    expect([...startable].sort()).toEqual(watchdogList.sort());
  });

  it("is a subset of the registry, and never the phone-facing worker", () => {
    const registered = CRON_WORKERS.map((w) => w.id);
    for (const id of startable) {
      expect(registered, `${id} is not a registered worker`).toContain(id);
      expect(CRON_WORKERS.find((w) => w.id === id)!.sendsCustomerRequests).toBe(false);
    }
    expect(startable).not.toContain("renew-subscriptions");
  });

  it("covers every worker that cannot reach a phone", () => {
    // The other direction: a safe worker left off the list is one that silently
    // stops being supervised, which reads as "the supervisor ran and left it".
    const safe = CRON_WORKERS.filter((w) => !w.sendsCustomerRequests).map((w) => w.id);
    expect([...startable].sort()).toEqual([...safe].sort());
  });
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

describe("summarizeSupervisorRun", () => {
  const decision = (id: CronWorkerId): SupervisorDecision => ({ id, name: id, reason: "late" });

  it("names what ran and what it returned", () => {
    const line = summarizeSupervisorRun(
      [
        { ...decision("release-earnings"), ran: true, summary: "Released TZS 0 for 0 creator(s)" },
        { ...decision("poll-encoding"), ran: true, summary: "3 checked, 1 published, 0 failed" },
      ],
      []
    );

    expect(line).toContain("Ran 2 overdue worker(s)");
    expect(line).toContain("1 published");
  });

  it("says so when nothing was overdue", () => {
    expect(summarizeSupervisorRun([], [])).toBe(
      "Nothing was overdue — every worker is inside its own budget."
    );
  });

  it("does not read a refusal as a failure", () => {
    const line = summarizeSupervisorRun(
      [{ ...decision("reconcile-payments"), ran: false, summary: "a run is already in flight" }],
      []
    );

    expect(line).toContain("already running");
    expect(line).not.toContain("FAILED");
  });

  it("never lets a failure and a refusal share a sentence", () => {
    // One means the job died; the other means it is running twice. Reading them
    // the same way is how a broken worker gets reported as a busy one.
    const line = summarizeSupervisorRun(
      [
        { ...decision("poll-encoding"), ran: false, error: "Bunny API 401" },
        { ...decision("reconcile-payments"), ran: false, summary: "a run is already in flight" },
      ],
      []
    );

    expect(line).toContain("FAILED: poll-encoding (Bunny API 401)");
    expect(line).toContain("Skipped 1 that were already running: reconcile-payments");
  });

  it("says which overdue workers it left for a person", () => {
    const line = summarizeSupervisorRun([], [decision("renew-subscriptions")]);
    expect(line).toContain("Left for a person: renew-subscriptions");
  });
});

describe("snapshotSupervisorHealth", () => {
  it("publishes the same verdict word /api/health would", () => {
    const health = healthOf([late("poll-encoding"), worker("release-earnings", { state: "ok" })]);
    const snapshot = snapshotSupervisorHealth(health);

    expect(snapshot.verdict).toBe("late");
    expect(snapshot.counts.late).toBe(1);
    expect(snapshot.checkedAt).toBe(health.checkedAt);
    expect(snapshot.attentionSummary).toBe(health.attentionSummary);
  });

  it("reports ok for a deployment with nothing wrong", () => {
    expect(snapshotSupervisorHealth(healthOf([worker("release-earnings")])).verdict).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The wiring: this runs real workers, so the route must be a cron route
// ---------------------------------------------------------------------------

describe("the supervisor route", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "cron", "supervisor", "route.ts"),
    "utf8"
  );

  it("is authorized like every other cron route", () => {
    // Both verbs delegate to one handler, so the guard is written once and
    // covers both — asserted together with the delegation, because a second
    // verb added later without it is the shape this is watching for.
    expect(route.match(/requireCronSecret\(request\)/g)).toHaveLength(1);
    expect(route.match(/export async function (GET|POST)/g)).toHaveLength(2);
    expect(route.match(/return handle\(request\)/g)).toHaveLength(2);
  });

  it("starts workers through the shared runner, so they take the lock and stamp a heartbeat", () => {
    expect(route).toContain("runWorkerNow(");
  });

  it("cannot be asked to run a named worker", () => {
    // The caller picks nothing: the plan comes from the heartbeats. If a request
    // could name a worker, it could name the one that charges a phone.
    expect(route).not.toContain("request.json()");
    expect(route).not.toContain("searchParams");
  });

  it("allows long enough for several jobs in one poke", () => {
    expect(route).toMatch(/export\s+const\s+maxDuration\s*=\s*60/);
  });

  it("reads the heartbeats live, so a cached answer cannot hide a stale schedule", () => {
    expect(route).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("the supervisor's runs are filed as its own", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "cron", "supervisor", "route.ts"),
    "utf8"
  );
  const service = readFileSync(
    join(process.cwd(), "src", "lib", "services", "cron-supervisor.service.ts"),
    "utf8"
  );

  it("labels them with the supervisor origin, not the watchdog's", () => {
    // The heartbeat is the record of who moved money. A run must not claim to be
    // something it was not — and the recovery notice reads the same column to
    // decide whether a worker came back on its own.
    expect(route).toContain("origin: SUPERVISOR_ORIGIN_LABEL");
    expect(route).not.toContain("WATCHDOG_ORIGIN_LABEL");
  });

  it("never starts a worker outside the planned list", () => {
    // One place that runs a worker, driven by the plan — a second call site is
    // how a worker nobody planned for gets started.
    expect(route.match(/runWorkerNow\(/g)).toHaveLength(1);
    expect(service).not.toContain("runWorkerNow(");
  });
});
