// =============================================================================
// GENHUB - The shared job runner and the manual trigger
//
// The scheduled routes and the admin panel's "Run now" button both reach a
// worker through lib/services/cron-jobs.service.ts. That sharing is the whole
// point of the file: what an operator proves from the dashboard has to be what
// the schedule will do, not a second implementation of it that can quietly
// disagree.
//
// So these tests cover the two ways that sharing can break:
//
//   1. a worker wired to the wrong job, or to a job whose summary no longer
//      says what happened (the summary is what the dashboard shows);
//   2. a trigger that starts a customer-facing worker without the phone-shaped
//      warning it needs.
//
// The trigger's guards are asserted from the route source, the way the
// /api/health caching test is: they are properties of the endpoint itself
// (auth, refusal codes, duration budget) rather than of a function, and the
// behavioural proof is in the live end-to-end run.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeEncoding,
  describeReconcile,
  describeReleaseEarnings,
  describeRenewals,
} from "@/lib/services/cron-jobs.service";
import { CRON_WORKERS } from "@/lib/services/cron-heartbeat.service";

// -----------------------------------------------------------------------------
// 1. Wording — this text is the dashboard
// -----------------------------------------------------------------------------

describe("worker result summaries", () => {
  it("says how much money moved, in the currency it moved", () => {
    const summary = describeReleaseEarnings({ released: 123456, creators: 3 });
    expect(summary).toContain("TZS");
    // Grouped, because these numbers are read at a glance: 123,456 and not
    // 123456.
    expect(summary).toContain("123,456");
    expect(summary).toContain("3 creator(s)");
  });

  it("separates what was settled from what needs a human", () => {
    // The one distinction the reconciliation panel exists for: a charge that
    // was flagged for investigation is not a failure and not a success, and a
    // summary that lumps them together hides the money someone has to chase.
    const summary = describeReconcile({
      checked: 4,
      settledSuccess: 1,
      settledFailed: 0,
      underInvestigation: 2,
      stillProcessing: 1,
      awaitingResolution: 1,
      errors: 0,
      gatewayUnavailable: false,
      unchecked: 0,
    });

    expect(summary).toContain("4 checked");
    expect(summary).toContain("2 newly flagged");
    expect(summary).toContain("1 awaiting resolution");
  });

  it("says when a sweep stopped early, so a short sweep cannot read as a quiet one", () => {
    const summary = describeReconcile({
      checked: 0,
      settledSuccess: 0,
      settledFailed: 0,
      underInvestigation: 0,
      stillProcessing: 0,
      awaitingResolution: 0,
      errors: 0,
      gatewayUnavailable: true,
      unchecked: 42,
    });

    expect(summary).toContain("STOPPED EARLY");
    expect(summary).toContain("42 not checked");
  });

  it("names the USSD pushes, because those are on someone's phone", () => {
    const summary = describeRenewals({
      considered: 5,
      renewedFromWallet: 1,
      pushedToPhone: 2,
      awaitingApproval: 1,
      failed: 1,
      skippedNoFloat: 0,
      skipped: 0,
      errors: 0,
    });

    expect(summary).toContain("1 from wallet");
    expect(summary).toContain("2 USSD push(es)");
    expect(summary).toContain("1 failed");
  });

  it("names a float hold, because the missing number is a sale nobody made", () => {
    const summary = describeRenewals({
      considered: 3,
      renewedFromWallet: 1,
      pushedToPhone: 0,
      awaitingApproval: 0,
      failed: 0,
      skippedNoFloat: 2,
      skipped: 0,
      errors: 0,
    });

    expect(summary).toContain("2 held");
    // The action, not just the symptom: this is read on a phone by an operator.
    expect(summary).toContain("float is empty");
  });

  it("reports encoding in the terms the creator cares about", () => {
    const summary = describeEncoding({ checked: 6, published: 4, ready: 5, failed: 1 });
    expect(summary).toContain("6 checked");
    expect(summary).toContain("4 published");
    expect(summary).toContain("1 failed");
  });
});

// -----------------------------------------------------------------------------
// 2. Wiring — every worker must be reachable from one place
// -----------------------------------------------------------------------------

describe("job wiring", () => {
  const runner = readFileSync(
    join(process.cwd(), "src", "lib", "services", "cron-jobs.service.ts"),
    "utf8"
  );

  it("runs every registered worker, and only registered workers", () => {
    const wired: string[] = [];
    const pattern = /runCronJob\(\s*"([a-z-]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(runner)) !== null) wired.push(match[1]);

    expect(wired.sort()).toEqual(CRON_WORKERS.map((w) => w.id).sort());
  });

  it("does not let a cron route call a job service directly", () => {
    // Reaching a service straight from a route is how the lock and the
    // heartbeat get skipped — the worker would run with nobody able to see that
    // it did, or stop a second run from doing it twice.
    const serviceFns = [
      "releaseMatureEarnings",
      "reconcileStalePayments",
      "renewDueSubscriptions",
      "refreshPendingEncodings",
    ];

    for (const w of CRON_WORKERS) {
      const route = readFileSync(
        join(process.cwd(), "src", "app", "api", "cron", w.id, "route.ts"),
        "utf8"
      );
      for (const fn of serviceFns) {
        expect(
          route.includes(`${fn}(`),
          `${w.id}/route.ts calls ${fn}() directly — run it through runWorkerNow()`
        ).toBe(false);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// 3. The manual trigger
// -----------------------------------------------------------------------------

describe("/api/admin/jobs/run", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "app", "api", "admin", "jobs", "run", "route.ts"),
    "utf8"
  );

  it("is admin only", () => {
    expect(source).toContain('requireRole("ADMIN")');
  });

  it("refuses a worker that is already running instead of starting it twice", () => {
    expect(source).toContain("ALREADY_RUNNING");
    expect(source).toContain("!outcome.ran");
  });

  it("requires a confirmation before it can charge a customer's phone", () => {
    // Enforced in the endpoint, not only in the button: a guard that lives in
    // the UI is a guard a stray request walks past.
    expect(source).toContain("sendsCustomerRequests");
    expect(source).toContain("CONFIRMATION_REQUIRED");
  });

  it("records that a person started the run", () => {
    expect(source).toContain("manual run from the admin panel");
  });

  it("allows long enough for the worker that sends USSD pushes", () => {
    // The default function budget would cut renewal off mid-run — after it had
    // already sent some of the pushes.
    expect(source).toMatch(/export\s+const\s+maxDuration\s*=\s*\d+/);
  });
});
