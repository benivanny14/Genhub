// =============================================================================
// GENHUB - When the watchdog wakes somebody up
//
// The rules are not obvious and both mistakes are expensive: a watchdog that
// misses an outage is useless, and one that cries wolf every hour gets muted —
// which is worse, because it is the muted alarm that hides the real outage.
//
// So every branch is pinned here rather than discovered in production at 3am.
// The two that matter most:
//
//   * `never` is NOT an alarm. It means no scheduler is configured yet, which is
//     setup work, and /api/health already decided that by answering 200. Alarming
//     on it would keep a fresh deployment permanently red.
//   * A 503 that this script cannot explain IS an alarm. The endpoint only
//     reports degraded for database and job reasons, so anything else means it
//     is unhealthy for a cause we cannot see — the worst possible thing to
//     shrug at.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RECOVERABLE_WORKERS,
  alertMessage,
  assessHealth,
  describeRunOutcome,
  describeStoppedWorkers,
  noticeMessage,
  planRecoveries,
  recoveryEnabled,
  shouldRecover,
} from "../../scripts/watchdog.mjs";
import { CRON_WORKERS } from "@/lib/services/cron-heartbeat.service";

/** A healthy response, with the parts each test cares about overridden. */
function health(overrides: Record<string, any> = {}, status = 200) {
  const payload = {
    status: "ok",
    checks: { database: "up", backgroundJobs: "ok", payments: "live" },
    warnings: [],
    ...overrides,
  };
  return { payload, status };
}

describe("assessHealth", () => {
  it("says nothing about a healthy site", () => {
    const { payload, status } = health();
    const report = assessHealth(payload, status);

    expect(report).toEqual({ ok: true, alarms: [], notices: [] });
  });

  // -------------------------------------------------------------- outages
  it("alarms when the database is unreachable", () => {
    const { payload, status } = health(
      { status: "degraded", checks: { database: "down", backgroundJobs: "ok" } },
      503
    );
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(false);
    expect(report.alarms.join("\n")).toContain("database is down");
    // One alarm, not two: the status code is explained by the database.
    expect(report.alarms).toHaveLength(1);
  });

  it.each(["late", "stalled", "failing"])(
    "alarms when the background jobs are %s",
    (jobs) => {
      const { payload, status } = health(
        { status: "degraded", checks: { database: "up", backgroundJobs: jobs } },
        503
      );
      const report = assessHealth(payload, status);

      expect(report.ok).toBe(false);
      expect(report.alarms.join("\n")).toContain(`background jobs: ${jobs}`);
      // The alert has to say where the answer is, since the detail is
      // deliberately not public.
      expect(report.alarms.join("\n")).toContain("Background jobs");
    }
  );

  it("alarms when the jobs verdict cannot be read at all", () => {
    const { payload, status } = health({
      checks: { database: "up", backgroundJobs: "unknown" },
    });
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(false);
    expect(report.alarms.join("\n")).toContain('got "unknown"');
  });

  it("alarms on a degraded answer it cannot explain", () => {
    // Nothing in the body says why. That is not a reason to stay quiet.
    const { payload, status } = health({ status: "degraded" }, 503);
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(false);
    expect(report.alarms.join("\n")).toContain("HTTP 503");
  });

  it("alarms when the endpoint is not the health endpoint", () => {
    // A proxy, a parking page or a 502 from the platform: 200 with HTML, which
    // parses to nothing. Far more likely than a well-formed lie.
    const report = assessHealth(null, 200);

    expect(report.ok).toBe(false);
    expect(report.alarms.join("\n")).toContain("did not answer with JSON");
  });

  // ------------------------------------------- setup, not an outage
  it("does not alarm when no worker has ever run", () => {
    const { payload, status } = health({
      checks: { database: "up", backgroundJobs: "never" },
    });
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(true);
    expect(report.alarms).toEqual([]);
    expect(report.notices.join("\n")).toContain("never run");
    // Named as setup so nobody chases it as an outage.
    expect(report.notices.join("\n")).toContain("Setup, not an outage");
  });

  it("does not alarm on sandbox payments, but does say so", () => {
    const { payload, status } = health({ checks: { database: "up", backgroundJobs: "ok", payments: "sandbox" } });
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(true);
    expect(report.notices.join("\n")).toContain("SANDBOX");
  });

  it("stays quiet when the only oddity is that nothing has been set up yet", () => {
    const { payload, status } = health({
      checks: { database: "up", backgroundJobs: "never", payments: "sandbox" },
    });
    const report = assessHealth(payload, status);

    expect(report.ok).toBe(true);
    expect(report.alarms).toEqual([]);
    expect(report.notices).toHaveLength(2);
  });
});

describe("alertMessage", () => {
  it("names the site and the problem, which is all a notification shows", () => {
    const { payload, status } = health(
      { status: "degraded", checks: { database: "up", backgroundJobs: "stalled" } },
      503
    );
    const message = alertMessage("https://genhub.co.tz", assessHealth(payload, status));

    expect(message).toContain("https://genhub.co.tz");
    expect(message).toContain("stalled");
  });

  it("names the worker that stopped when the detail is available", () => {
    const { payload, status } = health(
      { status: "degraded", checks: { database: "up", backgroundJobs: "late" } },
      503
    );
    const report = assessHealth(payload, status);

    const message = alertMessage(
      "https://genhub.co.tz",
      report,
      "Reconcile stale payments: nothing finished for 3 h"
    );

    expect(message).toContain("Reconcile stale payments");
    expect(message).toContain("3 h");
    // The problem itself is still there: the detail is added to the alarm, not
    // swapped for it.
    expect(message).toContain("background jobs: late");
  });

  it("is exactly the same alarm without the detail", () => {
    const { payload, status } = health(
      { status: "degraded", checks: { database: "up", backgroundJobs: "late" } },
      503
    );
    const report = assessHealth(payload, status);
    const withoutDetail = alertMessage("https://genhub.co.tz", report);

    // Whitespace-only must not leave a dangling separator in a notification.
    expect(alertMessage("https://genhub.co.tz", report, "   ")).toBe(withoutDetail);
    expect(withoutDetail).not.toMatch(/—\s*$/);
  });
});

// -----------------------------------------------------------------------------
// The detail behind the alert
//
// /api/health is public and publishes the verdict only, so the worker names come
// from a secret-guarded sibling. Two properties have to hold or the feature is
// worse than not having it: the alarm must be exactly as loud when the detail is
// missing (a second credential cannot be allowed to silence it), and the public
// endpoint must not start leaking the detail instead.
// -----------------------------------------------------------------------------

describe("describeStoppedWorkers", () => {
  it("uses the sentence the server built, so both cannot drift apart", () => {
    const detail = {
      verdict: "stalled",
      summary: "Reconcile stale payments: a run started 32 min ago and never finished",
      workers: [{ id: "reconcile-payments", name: "Reconcile stale payments", state: "stalled" }],
    };

    expect(describeStoppedWorkers(detail)).toBe(detail.summary);
  });

  it("falls back to naming the workers when only the list arrived", () => {
    const detail = {
      workers: [
        { id: "reconcile-payments", name: "Reconcile stale payments", silentForMinutes: 32 },
        { id: "release-earnings", name: "Release matured earnings", silentForMinutes: 185 },
      ],
    };

    const line = describeStoppedWorkers(detail);
    expect(line).toContain("Reconcile stale payments (silent 32 min)");
    expect(line).toContain("Release matured earnings (silent 185 min)");
  });

  it("falls back to the id when the name is missing", () => {
    expect(describeStoppedWorkers({ workers: [{ id: "poll-encoding" }] })).toContain(
      "poll-encoding"
    );
  });

  it.each([null, undefined, "", "late", 42, {}, { summary: "   " }, { workers: "nope" }, []])(
    "says nothing useful about %s, rather than something wrong",
    (bad) => {
      expect(describeStoppedWorkers(bad)).toBe("");
    }
  );
});

/**
 * Source with comments removed.
 *
 * A guard that reads prose fails on prose: this route's header *describes* the
 * rule it is being held to ("every route in that tree is required to run through
 * runWorkerNow()"), and reading that as evidence the route runs a worker is the
 * mistake env-template.test.ts already had to fix for environment keys. Only
 * comments are dropped, never a line of code, so this cannot hide a real call.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the detail endpoint", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "health", "attention", "route.ts"),
    "utf8"
  );
  const publicHealth = readFileSync(
    join(process.cwd(), "src", "app", "api", "health", "route.ts"),
    "utf8"
  );

  it("is guarded by the scheduler secret, which is the point of the split", () => {
    expect(route).toContain("export const dynamic = \"force-dynamic\"");
    // Both verbs, not just the first one: POST is the one that writes, and a
    // guard that covers only the read would be found by nobody until it was
    // used. Counted, so adding a handler without a guard fails here.
    expect(route.match(/requireCronSecret\(request\)/g)).toHaveLength(2);
  });

  it("carries the one fact the restart guard reads", () => {
    // Not decoration: the watchdog decides whether a worker may be started from
    // this field, so a payload that stopped sending it would silently turn every
    // restart into a refusal — the safe direction, but a broken feature.
    expect(route).toContain("sendsCustomerRequests");
  });

  it("moves nothing — no worker runs, no lock is taken, no heartbeat is written", () => {
    const code = withoutComments(route);
    expect(code).not.toContain("runWorkerNow(");
    expect(code).not.toContain("runCronJob(");
    // Nor does it write a heartbeat of its own: a read must not look like work.
    expect(code).not.toContain("cronHeartbeat");
    // It does record the watchdog's memory (syncCronWatch) — but that is a
    // service call, so every write it makes is described by the service tests
    // above. Touching the database from here would put those rules beyond them.
    expect(code).not.toContain("prisma.");
  });

  it("keeps the public endpoint a verdict, with no worker names in it", () => {
    // The split only means something if the public half stays public-safe. If
    // someone folds the detail back into /api/health, this fails.
    const code = withoutComments(publicHealth);
    expect(code).not.toContain("attentionSummary");
    expect(code).not.toContain("needsAttention");
    expect(code).not.toContain("workersNeedingAttention");
  });
});

// -----------------------------------------------------------------------------
// Restarting a worker, and the one that may never be restarted
//
// A watchdog that only shouts leaves the outage in place for as long as it takes
// somebody to read the alarm — at 3am, that is hours of unpaid creators. So it
// starts the stopped worker itself. The property that has to hold is narrower
// than "it recovers things": it must be *impossible* for this path to push a
// charge request at a customer, because that money cannot be given back by
// cancelling a run.
//
// `renew-subscriptions` sends a USSD prompt to a fan's phone when their wallet
// cannot cover a renewal. It is never started from here — and these tests fail if
// that ever changes, rather than trusting a comment.
// -----------------------------------------------------------------------------

describe("shouldRecover", () => {
  /** The default payload for a worker the watchdog is allowed to start. */
  const safe = {
    id: "release-earnings",
    name: "Release matured earnings",
    state: "late",
    sendsCustomerRequests: false,
  };

  it("starts a worker that stopped, when it is safe to start", () => {
    expect(shouldRecover(safe)).toEqual({ recover: true, reason: expect.any(String) });
  });

  it("never starts the worker that can charge a customer's phone", () => {
    const verdict = shouldRecover({
      ...safe,
      id: "renew-subscriptions",
      name: "Renew subscriptions",
      sendsCustomerRequests: true,
    });

    expect(verdict.recover).toBe(false);
    expect(verdict.reason).toContain("phone");
  });

  it("treats an unclassified worker as one that can charge, not as safe", () => {
    // The flag is read against `false`, not "not true". A worker added with no
    // decision recorded about who it can reach must not inherit permission.
    for (const flag of [undefined, null, true, "false", 0] as any[]) {
      const verdict = shouldRecover({ ...safe, sendsCustomerRequests: flag });
      expect(verdict.recover, `sendsCustomerRequests=${String(flag)}`).toBe(false);
    }
  });

  it("leaves a worker alone that is not a stopped schedule", () => {
    // `stalled` and `failing` both mean the job IS being triggered and dies when
    // it runs: starting it again repeats the same death. `never` is setup work,
    // and running the job by hand would hide the thing that needs doing.
    for (const state of ["stalled", "failing", "never", "running", "ok"]) {
      const verdict = shouldRecover({ ...safe, state });
      expect(verdict.recover, state).toBe(false);
      expect(verdict.reason, state).toContain(state);
    }
  });

  it("leaves alone a worker it has not been told to touch", () => {
    expect(shouldRecover({ ...safe, id: "process-holdings" }).recover).toBe(false);
    expect(shouldRecover({ ...safe, id: "" }).recover).toBe(false);
    expect(shouldRecover(undefined).recover).toBe(false);
  });

  it("can be switched off without giving up the alarm", () => {
    const verdict = shouldRecover(safe, { enabled: false });
    expect(verdict.recover).toBe(false);
    expect(verdict.reason).toContain("WATCHDOG_RECOVER");
  });
});

describe("recoveryEnabled", () => {
  it("is on unless somebody says otherwise", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(recoveryEnabled(value)).toBe(true);
    }
    for (const value of ["1", "true", "yes", "on", "ON", " true "]) {
      expect(recoveryEnabled(value), String(value)).toBe(true);
    }
  });

  it.each(["off", "false", "0", "no", "maybe", "disabled", "omo"]) (
    "fails closed on %s rather than arming itself",
    (value) => {
      expect(recoveryEnabled(value)).toBe(false);
    }
  );
});

describe("planRecoveries", () => {
  const detail = {
    workers: [
      { id: "release-earnings", name: "Release matured earnings", state: "late", sendsCustomerRequests: false },
      { id: "renew-subscriptions", name: "Renew subscriptions", state: "late", sendsCustomerRequests: true },
      { id: "reconcile-payments", name: "Reconcile stale payments", state: "stalled", sendsCustomerRequests: false },
    ],
  };

  it("restarts the stopped safe workers and explains the one it will not touch", () => {
    const plan = planRecoveries(detail);

    expect(plan.restarts.map((w) => w.id)).toEqual(["release-earnings"]);
    // The reason travels in the alert, so nobody has to wonder whether the
    // watchdog forgot about the worker it left stuck.
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0].name).toBe("Renew subscriptions");
    expect(plan.held[0].reason).toContain("phone");
    // A stalled worker is left alone too, but silently: the detail on the card
    // already says what a killed run means. Two sentences about one problem is
    // how an alert stops being read.
    expect(plan.held.map((w) => w.id)).not.toContain("reconcile-payments");
  });

  it("plans nothing when it was told nothing", () => {
    for (const bad of [null, undefined, {}, { workers: "nope" }, []] as any[]) {
      expect(planRecoveries(bad)).toEqual({ restarts: [], held: [] });
    }
  });

  it("explains, rather than hides, that restarts are switched off", () => {
    const plan = planRecoveries(detail, { enabled: false });
    expect(plan.restarts).toEqual([]);
    // Every stopped worker gets a sentence, or the reader is left wondering
    // whether the watchdog simply forgot. That no restart will happen is a
    // decision the operator made, and the alert should remind them of it.
    expect(plan.held.map((w) => w.name)).toEqual([
      "Release matured earnings",
      "Renew subscriptions",
    ]);
    expect(plan.held[0].reason).toContain("WATCHDOG_RECOVER");
    // The worker that can charge a phone keeps its own reason even then: that is
    // the invariant, not a setting.
    expect(plan.held[1].reason).toContain("phone");
  });
});

describe("describeRunOutcome", () => {
  it("reads the job's own sentence when the route sends one", () => {
    expect(describeRunOutcome({ success: true, message: "Released TZS 9,000 for 2 creator(s)" })).toBe(
      "ran — Released TZS 9,000 for 2 creator(s)"
    );
  });

  it("reports a refusal as a refusal, not as a run", () => {
    expect(describeRunOutcome({ status: "skipped", reason: "a run is already in flight" })).toBe(
      "skipped — a run is already in flight"
    );
    expect(describeRunOutcome({ success: true, data: { skipped: true, reason: "locked" } })).toBe(
      "skipped — locked"
    );
    expect(describeRunOutcome({ skipped: true })).toBe("skipped — a run is already in flight");
  });

  it("still says the run happened when the body is unfamiliar", () => {
    // A restart that worked must never be reported as a failure because its JSON
    // was not the shape this script expected.
    expect(describeRunOutcome({ status: "ok", settledSuccess: 3 })).toBe("ran");
    expect(describeRunOutcome(null)).toBe("ran");
  });
});

describe("the restart list and the worker registry", () => {
  it("only lists workers that cannot reach a customer's phone", () => {
    // The script keeps its own list on purpose (a worker added tomorrow is not
    // restarted by an old watchdog), which means the two can drift. This is the
    // test that makes drifting impossible: the list is a subset of the registry,
    // and a mismatch fails here rather than on somebody's phone.
    for (const id of RECOVERABLE_WORKERS) {
      const worker = CRON_WORKERS.find((w) => w.id === id);
      expect(worker, `${id} is not a registered worker`).toBeTruthy();
      expect(worker!.sendsCustomerRequests, `${id} can charge a phone`).toBe(false);
    }
  });

  it("never lists a worker that sends customer requests", () => {
    const chargeable = CRON_WORKERS.filter((w) => w.sendsCustomerRequests).map((w) => w.id);
    // If this ever becomes empty the guard below proves nothing, so it is
    // asserted rather than assumed.
    expect(chargeable.length).toBeGreaterThan(0);
    for (const id of chargeable) {
      expect(RECOVERABLE_WORKERS).not.toContain(id);
    }
  });
});

describe("alertMessage with the recovery lines", () => {
  const { payload, status } = health(
    { status: "degraded", checks: { database: "up", backgroundJobs: "late" } },
    503
  );
  const report = assessHealth(payload, status);

  it("reads as one sentence, in the order the work happened", () => {
    const message = alertMessage("https://genhub.co.tz", report, [
      "Release matured earnings: nothing finished for 4 h",
      "Restarted Release matured earnings: ran — Released TZS 9,000 for 2 creator(s)",
      "Left Renew subscriptions alone: it can send a charge request to a customer's phone",
    ]);

    expect(message).toContain("background jobs: late");
    expect(message.indexOf("nothing finished for 4 h")).toBeLessThan(
      message.indexOf("Restarted Release matured earnings")
    );
    expect(message.indexOf("Restarted Release matured earnings")).toBeLessThan(
      message.indexOf("Left Renew subscriptions alone")
    );
  });

  it("stays the same alarm when there is nothing to add", () => {
    const bare = alertMessage("https://genhub.co.tz", report);
    expect(alertMessage("https://genhub.co.tz", report, [])).toBe(bare);
    expect(alertMessage("https://genhub.co.tz", report, ["", "   "])).toBe(bare);
    expect(bare).not.toMatch(/—\s*$/);
  });
});

// -----------------------------------------------------------------------------
// The recovery notice
//
// The alarm and the all-clear share a channel, and the preview line is often all
// anybody reads. So the two must not look alike: one says something is wrong
// right now, the other says it stopped being wrong. Anything less and the good
// news starts getting skimmed in the same motion as the bad.
// -----------------------------------------------------------------------------

describe("noticeMessage", () => {
  it("says nothing when there is nothing to say", () => {
    // Every run calls this, including the runs where everything is fine.
    expect(noticeMessage("https://genhub.co.tz", "")).toBe("");
    expect(noticeMessage("https://genhub.co.tz", "   ")).toBe("");
    expect(noticeMessage("https://genhub.co.tz", undefined)).toBe("");
  });

  it("cannot be mistaken for the alarm", () => {
    const summary = "Release matured earnings is running again after 4 h — the schedule is firing again";
    const notice = noticeMessage("https://genhub.co.tz", summary);
    const alarm = alertMessage(
      "https://genhub.co.tz",
      assessHealth(health({ status: "degraded", checks: { database: "up", backgroundJobs: "late" } }, 503).payload, 503)
    );

    expect(notice).toContain("recovered:");
    expect(notice).toContain(summary);
    for (const word of ["background jobs", "could not reach"]) {
      expect(notice).not.toContain(word);
    }
    expect(alarm).not.toContain("recovered:");
  });

  it("reports a recovery without ever letting it hide a problem", () => {
    // Two properties, both from the source, because they are the difference
    // between a nudge and an all-clear: the notice is only sent when the run is
    // otherwise clean, and the run still exits non-zero when it is not.
    const code = withoutComments(
      readFileSync(join(process.cwd(), "scripts", "watchdog.mjs"), "utf8")
    );

    // Sent in the `report.ok` branch only — i.e. the alarm was not raised.
    const alarmBranch = code.indexOf("if (alertUrl && !report.ok)");
    const noticeBranch = code.indexOf("else if (alertUrl && recovered)");
    expect(alarmBranch).toBeGreaterThan(-1);
    expect(noticeBranch).toBeGreaterThan(alarmBranch);

    // And the exit code is still driven by the alarm alone: a recovery is not a
    // reason to sleep through a run that failed.
    const exitBranch = code.indexOf("if (!report.ok)", noticeBranch);
    expect(exitBranch).toBeGreaterThan(noticeBranch);
    expect(code.slice(exitBranch, exitBranch + 400)).toContain("process.exit(1)");
  });

  it("reads the state before it repairs anything", () => {
    // The ordering is the value of the memory, and it is invisible from the
    // outside: a restart writes a fresh heartbeat, so a sighting taken after it
    // says "this worker is fine". The recovery then never fires for a worker the
    // watchdog rescued — the alarm goes quiet because a repair succeeded, and
    // nobody is told the schedule is still dead.
    //
    // This is not hypothetical: the first cut recorded after the restarts, and
    // it passed every other test in this file, because they call syncCronWatch
    // directly and the mistake lived in the CLI's step order.
    const code = withoutComments(
      readFileSync(join(process.cwd(), "scripts", "watchdog.mjs"), "utf8")
    );

    // The call sites, not the declarations — the helpers are defined above the
    // CLI block, so matching bare names would compare the wrong two things.
    const reading = code.indexOf("await syncWatch(");
    const planning = code.indexOf("const plan = planRecoveries(detail");
    const restarting = code.indexOf("await restartWorker(baseUrl");
    expect(reading).toBeGreaterThan(-1);
    expect(planning).toBeGreaterThan(-1);
    expect(reading).toBeLessThan(planning);
    expect(reading).toBeLessThan(restarting);

    // And exactly once per run: a second sighting would close the mark the first
    // one opened, which is the same outage reported as already over.
    expect(code.match(/await syncWatch\(/g)).toHaveLength(1);
  });
});
