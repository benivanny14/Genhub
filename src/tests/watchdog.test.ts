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

import { assessHealth, alertMessage, describeStoppedWorkers } from "../../scripts/watchdog.mjs";

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
    expect(route).toContain("requireCronSecret(request)");
    expect(route).toContain("export const dynamic = \"force-dynamic\"");
  });

  it("moves nothing — it reads, so it never takes a lock or writes a heartbeat", () => {
    const code = withoutComments(route);
    expect(code).not.toContain("runWorkerNow(");
    expect(code).not.toContain("runCronJob(");
    // Nor does it write a heartbeat of its own: a read must not look like work.
    expect(code).not.toContain("cronHeartbeat");
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
