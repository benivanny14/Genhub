// =============================================================================
// GENHUB - The cron supervisor: one poke runs everything that is overdue
//
// The four workers each have their own schedule (§4.0.1), and on GitHub Actions
// those schedules are not kept. Measured on this repository over 24 h: a `*/5`
// schedule was delivered every 138-341 minutes, a `*/10` every 137-336, and the
// two hourly ones every 3h19-5h36. GitHub's minimum interval is 5 minutes and
// its delivery is "best effort", so the file said one thing and the runner did
// another — and a worker only ever ran when *its own* file happened to arrive.
//
// That is a scheduling problem no threshold can fix: the heartbeats are honest,
// the jobs really are hours late, and every one of them is `late` within minutes
// of a delivery. This service is the other half of the answer.
//
// A delivered schedule is a scarce, unreliable event, so each one is made to
// count: whichever trigger arrives asks the app to run *every* worker whose
// heartbeat is past its own budget, through the same lock and heartbeat as the
// schedule would have used. One poke therefore restores all four cadences, no
// matter which of the four files GitHub decided to deliver — or which external
// scheduler (§4.0.4) is calling.
//
// Two rules borrowed verbatim from the uptime watchdog, because getting either
// wrong is expensive in a way a test cannot undo:
//
//   * Only `late`. `ok` and `running` need nothing; `never` is unconfigured
//     setup that running by hand would paper over; `stalled` and `failing` mean
//     the job *is* being triggered and dies when it runs, so starting it again
//     repeats the same death instead of recovering anything.
//   * `renew-subscriptions` is never started automatically. It falls back to a
//     USSD charge request on a fan's phone, so it is the one run that can cost
//     somebody money they did not ask to spend. A missed renewal is recoverable
//     by a human at a keyboard; a duplicate charge is not. It is reported as
//     held, with the reason, rather than silently skipped.
// =============================================================================

import {
  summarizeCronHealth,
  type CronHealth,
  type CronWorkerHealth,
  type CronWorkerId,
  type CronWorkerState,
} from "./cron-heartbeat.service";

/**
 * Workers the supervisor may start by itself.
 *
 * The same list `scripts/watchdog.mjs` keeps, for the same reason: the failure
 * that matters is not a missed run, it is starting something nobody asked for.
 * A worker added next year is not started by this file until somebody adds it
 * here on purpose — `src/tests/cron-supervisor.test.ts` fails if the two lists
 * drift apart, so the app and the watchdog cannot disagree about what is safe.
 */
export const SUPERVISOR_WORKERS: readonly CronWorkerId[] = [
  "release-earnings",
  "reconcile-payments",
  "poll-encoding",
];

export interface SupervisorDecision {
  id: CronWorkerId;
  name: string;
  /**
   * The heartbeat verdict this decision was made from.
   *
   * Carried so a reader can tell "overdue, and nobody may start it" from "never
   * ran" or "dies when it runs" without re-reading the heartbeats — the first is
   * a person's job right now, the others are not.
   */
  state: CronWorkerState;
  /** Why this worker is (or is not) being run, in words an operator can act on. */
  reason: string;
}

export interface SupervisorPlan {
  /** Workers this poke will run now, the longest-silent first. */
  run: SupervisorDecision[];
  /**
   * Workers that need someone and will not be run, with the reason.
   *
   * Carried rather than dropped on purpose: somebody who sees a worker stuck on
   * `late` and no run happening has to be told that was a decision, not
   * something the supervisor missed.
   */
  held: SupervisorDecision[];
}

/** The truthy half of a boolean column that may be missing. `undefined` is not a "no". */
function canReachACustomer(worker: CronWorkerHealth): boolean {
  return worker.sendsCustomerRequests !== false;
}

/**
 * What this poke should run.
 *
 * Pure — the whole decision is testable without a database, a clock or a
 * network, which is the same reason `classifyWorker` and `shouldRecover` are.
 */
export function planSupervisorRuns(health: CronHealth): SupervisorPlan {
  const run: SupervisorDecision[] = [];
  const held: SupervisorDecision[] = [];

  // Longest silence first: when several workers are overdue, the one that has
  // been quiet longest is the one whose consequence has been true longest.
  // Stable sort, so workers of equal age keep the registry's order.
  const workers = [...health.workers].sort(
    (a, b) => (b.silentForMinutes ?? 0) - (a.silentForMinutes ?? 0)
  );

  for (const worker of workers) {
    // Checked first so that it is the sentence read for the one worker that
    // actually matters — the same ordering rule the watchdog's guard uses.
    if (canReachACustomer(worker)) {
      held.push({
        id: worker.id,
        name: worker.name,
        state: worker.state,
        // The consequence, not the instruction: the caller that shows this to a
        // human (the response body, the hold alert) adds its own "press Run
        // now", and one of them appending it here produced the same three words
        // twice in one sentence.
        reason:
          `${worker.id} can send a charge request to a customer's phone, so it is never ` +
          "started automatically",
      });
      continue;
    }

    if (!SUPERVISOR_WORKERS.includes(worker.id)) {
      held.push({
        id: worker.id,
        name: worker.name,
        state: worker.state,
        reason: `${worker.id} is not one the supervisor may start`,
      });
      continue;
    }

    if (worker.state !== "late") {
      // Not an error and not a gap: `ok` and `running` are healthy, `never` is
      // setup work, and `stalled`/`failing` need a fix rather than another run.
      if (worker.state === "never" || worker.state === "stalled" || worker.state === "failing") {
        held.push({
          id: worker.id,
          name: worker.name,
          state: worker.state,
          reason: `${worker.id} is ${worker.state}, which another run does not fix — ${worker.detail}`,
        });
      }
      continue;
    }

    run.push({
      id: worker.id,
      name: worker.name,
      state: worker.state,
      reason: worker.detail,
    });
  }

  return { run, held };
}

export interface SupervisorRunResult extends SupervisorDecision {
  /** False when another trigger held the lock, or when the run itself failed. */
  ran: boolean;
  /** What the worker returned, or why it was refused, e.g. "a run is already in flight". */
  summary?: string | null;
  durationMs?: number;
  /** Set when the run threw — the scheduler sees a 500 for the poke in that case. */
  error?: string;
}

export interface SupervisorHealthSnapshot {
  verdict: "ok" | "late" | "stalled" | "failing" | "never";
  counts: CronHealth["counts"];
  needsAttention: CronWorkerId[];
  attentionSummary: string;
  checkedAt: string;
}

/**
 * The health of the deployment *after* a poke, in the shape a scheduler's log
 * can carry.
 *
 * `verdict` is `summarizeCronHealth`, the same word /api/health publishes, so a
 * workflow log and a monitor's alert cannot describe one deployment differently.
 */
export function snapshotSupervisorHealth(health: CronHealth): SupervisorHealthSnapshot {
  return {
    verdict: summarizeCronHealth(health),
    counts: health.counts,
    needsAttention: health.needsAttention,
    attentionSummary: health.attentionSummary,
    checkedAt: health.checkedAt,
  };
}

/**
 * The run, in one sentence, for the scheduler's log and the response body.
 *
 * Pure, so the wording is pinned by tests rather than discovered in a workflow
 * log at 3am.
 */
/**
 * What the hold alert did, in the shape the summary needs.
 *
 * Structural rather than importing the alert service: this module is the pure
 * half, and the alert service holds the database and the mailer.
 */
export interface HoldAlertSummary {
  /** Workers a person was told about on this poke. */
  alerted: readonly string[];
  /** Held and overdue, and nobody could be reached about them. */
  failed?: readonly string[];
  /** Nothing could be sent: there is no admin account to send it to. */
  noAdmins: boolean;
}

export function summarizeSupervisorRun(
  run: readonly SupervisorRunResult[],
  held: readonly SupervisorDecision[],
  alerts?: HoldAlertSummary
): string {
  const parts: string[] = [];

  const done = run.filter((r) => r.ran);
  if (done.length > 0) {
    parts.push(
      `Ran ${done.length} overdue worker(s): ` +
        done.map((r) => `${r.id} (${r.summary ?? "done"})`).join(", ")
    );
  }

  // A failure and a refusal are opposite facts and must never share a sentence:
  // one means the job died when it ran, the other means another trigger is
  // already running it — which is the worker being triggered, not a problem.
  const failed = run.filter((r) => r.error);
  if (failed.length > 0) {
    parts.push(`FAILED: ${failed.map((r) => `${r.id} (${r.error})`).join(", ")}`);
  }

  const refused = run.filter((r) => !r.ran && !r.error);
  if (refused.length > 0) {
    parts.push(
      `Skipped ${refused.length} that were already running: ${refused.map((r) => r.id).join(", ")}`
    );
  }

  if (held.length > 0) {
    parts.push(`Left for a person: ${held.map((h) => h.id).join(", ")}`);
  }

  if (alerts?.alerted.length) {
    parts.push(`Told an admin about: ${alerts.alerted.join(", ")}`);
  }

  // Both are loud, because they are the failures here that are otherwise
  // invisible: the poke succeeded, the worker is overdue, and nobody was told.
  if (alerts?.failed?.length) {
    parts.push(`NOT TOLD: ${alerts.failed.join(", ")}`);
  }

  if (alerts?.noAdmins) {
    parts.push("NOTHING WAS SENT: no admin account exists to be told");
  }

  if (parts.length === 0) return "Nothing was overdue — every worker is inside its own budget.";
  return parts.join(" · ");
}

/**
 * The run itself lives in the route, deliberately.
 *
 * Every route under /api/cron is required by `src/tests/cron-heartbeat.test.ts`
 * to reach a worker through `runWorkerNow`, so that no route can execute one
 * without its lock and heartbeat. Routing this through a service would satisfy
 * the rule's intent while failing the check that enforces it, and the check is
 * the only thing standing between a new route and a job that moves money with
 * nobody able to see that it ran.
 */
