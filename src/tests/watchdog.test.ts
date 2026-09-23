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

import { assessHealth, alertMessage } from "../../scripts/watchdog.mjs";

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
});
