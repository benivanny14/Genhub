// =============================================================================
// GENHUB - Cron: the supervisor
// GET/POST /api/cron/supervisor
//
// Runs every worker whose heartbeat is past its own budget. Scheduled pokes are
// scarce and unreliable (§4.0.1 — GitHub Actions delivered a `*/5` schedule every
// 2-6 hours on this repository), so this makes any one of them do the work of
// all: whichever trigger arrives, the workers that fell behind are started here,
// through the same lock and heartbeat the schedule would have used.
//
// It is a cron route like the others, and is authorized the same way — header
// only, timing-safe compare, fail closed in production (lib/cron-auth.ts).
//
// It does NOT take a worker id, on purpose. A caller cannot name a worker, so it
// cannot ask for the one that reaches a customer's phone: the list of workers
// this may start lives in the service, and renew-subscriptions is not on it.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api-response";
import { requireCronSecret, SUPERVISOR_ORIGIN_LABEL } from "@/lib/cron-auth";
import { getCronHealth } from "@/lib/services/cron-heartbeat.service";
import { runWorkerNow } from "@/lib/services/cron-jobs.service";
import { alertHeldWorkers } from "@/lib/services/cron-hold-alert.service";
import {
  planSupervisorRuns,
  snapshotSupervisorHealth,
  summarizeSupervisorRun,
  type SupervisorDecision,
  type SupervisorRunResult,
} from "@/lib/services/cron-supervisor.service";

// The default function budget would cut a poke that has to run three jobs one
// after another. Each finishes in seconds; the sum is what needs the room.
export const runtime = "nodejs";
export const maxDuration = 60;
// A cached answer here would be the whole failure mode this endpoint exists for:
// it must read the heartbeats as they are now.
export const dynamic = "force-dynamic";

/**
 * One planned worker, started through the shared runner.
 *
 * The run is labeled with the supervisor's own origin, not the watchdog's: the
 * heartbeat is the record of who moved money. Both labels mean "the schedule did
 * not bring this back", which is the fact the recovery notice reads — so a
 * worker woken here still reads as a schedule that is not firing (§4.0.2).
 *
 * A refusal (`ran: false` with no `error`) is not a failure: another trigger got
 * there first, which means the worker is being triggered at all.
 */
async function runSupervisedWorker(decision: SupervisorDecision): Promise<SupervisorRunResult> {
  try {
    const outcome = await runWorkerNow(decision.id, { origin: SUPERVISOR_ORIGIN_LABEL });

    return outcome.ran
      ? { ...decision, ran: true, summary: outcome.summary, durationMs: outcome.durationMs }
      : { ...decision, ran: false, summary: outcome.reason };
  } catch (error) {
    return {
      ...decision,
      ran: false,
      error: String((error as Error)?.message || error).slice(0, 200),
    };
  }
}

async function handle(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // Read first, decide once, then run: the plan is a snapshot of which workers
    // are overdue, so a run that finishes mid-loop cannot change who else runs.
    const before = await getCronHealth();
    const plan = planSupervisorRuns(before);

    // Sequential on purpose: these jobs share one database and move money, and
    // running them at once would trade a couple of seconds for contention.
    const ran: SupervisorRunResult[] = [];
    for (const decision of plan.run) {
      ran.push(await runSupervisedWorker(decision));
    }

    // A worker that is overdue and may not be started automatically will not run
    // again until a person starts it, so this poke tells one — with the record in
    // the bell and an email that reaches somebody who is not on the site. It is
    // throttled per worker, and it never throws: an overdue worker with nobody
    // told is a silent failure, and so is a mail host that takes the poke down.
    const alerts = await alertHeldWorkers(plan.held);

    // Re-read so the answer describes the deployment after the poke, not the one
    // it just repaired — this is the health a caller would otherwise fetch next.
    const health = snapshotSupervisorHealth(await getCronHealth());
    const report = { ran, held: plan.held, health, alerts };
    const summary = summarizeSupervisorRun(ran, plan.held, alerts);

    const failed = ran.filter((r) => r.error);
    if (failed.length > 0) {
      // A poke that answers 200 for a worker that threw would be another silent
      // failure, which is the class of bug this endpoint exists to end.
      return NextResponse.json(
        {
          success: false,
          error:
            `${failed.map((r) => r.id).join(", ")} failed: ` +
            failed.map((r) => r.error).join(" | "),
          code: "WORKER_RUN_FAILED",
          data: report,
        },
        { status: 500 }
      );
    }

    return api.success(report, summary);
  } catch (error) {
    console.error("[Cron Supervisor Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
