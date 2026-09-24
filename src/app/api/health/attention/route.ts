// =============================================================================
// GENHUB - Health detail, for the alert that has to name the worker
// GET  /api/health/attention  - who stopped, and for how long (read-only)
// POST /api/health/attention  - record this look, and report what came back
//
// /api/health answers with the verdict and nothing else — "background jobs:
// late". That is deliberate: it is public, an uptime monitor has no credentials,
// and a health endpoint that publishes which worker is behind and where its
// schedule lives is a map of the system handed to whoever asks.
//
// But a verdict is enough to alarm on and not enough to act on. The person who
// reads the alert then opens the dashboard to find out *which* worker stopped
// and how long it has been quiet, and that is the whole of what they needed. So
// the sentence lives here, behind the same CRON_SECRET the schedules already
// carry, and the watchdog asks for it while composing the alert.
//
// GET moves nothing: no lock, no heartbeat, no run. That is also why this is NOT
// under /api/cron — every route in that tree is a worker trigger and is required
// by a test to run through runWorkerNow(), and weakening that rule to fit a read
// would be the wrong trade.
//
// POST is the watchdog's memory, and it writes exactly one thing: whether each
// worker was already reported as needing attention. That memory is what lets a
// later run say a worker came back *and* whether it came back on its own or only
// because the watchdog restarted it — the difference between a fixed schedule
// and one that will need restarting again next hour. It still runs no worker, and
// still takes no lock.
//
// If the secret is missing (a fresh deployment, a fork, a monitor-only setup)
// this answers 401 and the watchdog keeps the alert it had before: a verdict and
// a pointer at the dashboard. The alarm never depends on this endpoint.
// =============================================================================

import { NextRequest } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { api } from "@/lib/api-response";
import {
  getCronHealth,
  summarizeCronHealth,
  syncCronWatch,
  workersNeedingAttention,
} from "@/lib/services/cron-heartbeat.service";

// The answer is the current state of four heartbeats. A cached one would report
// the thing an operator is asking about as of some earlier build, which is the
// bug this project already had to fix once in /api/health itself.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const health = await getCronHealth();

    return api.success({
      // The same word /api/health publishes, so an alert that carries both can
      // be read without cross-referencing anything.
      verdict: summarizeCronHealth(health),
      summary: health.attentionSummary,
      // Only the workers needing someone, most urgent first — the alert has no
      // use for the healthy ones.
      workers: workersNeedingAttention(health.workers).map((w) => ({
        id: w.id,
        name: w.name,
        state: w.state,
        silentForMinutes: w.silentForMinutes,
        silentSince: w.silentSince,
        detail: w.detail,
        // Whether a run of this worker can reach a customer's phone. The
        // watchdog refuses to restart any worker that says yes, and reads it
        // from here rather than keeping its own copy of the rule — a second
        // list is a second thing that can go stale about who gets charged.
        sendsCustomerRequests: w.sendsCustomerRequests,
      })),
    });
  } catch (error) {
    // "How is the alert detail doing" failing must never read as "everything is
    // fine": the caller gets an error and the alert falls back to the verdict.
    console.error("[Health Attention Error]", error);
    return api.internal();
  }
}

/**
 * Record this look, and say what recovered since the last one.
 *
 * Called on every watchdog run, healthy or not — the run that can notice a
 * recovery is precisely the run with nothing else to report, and that run would
 * otherwise end in silence. A failure here is reported to the caller, which
 * treats it as "no news" rather than as an outage: the alarm never depends on
 * this endpoint (see the header).
 */
export async function POST(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const sync = await syncCronWatch();

    return api.success({
      // One sentence the watchdog can put straight in a notification, so the
      // wording lives in one place instead of in whichever script noticed.
      summary: sync.summary,
      recovered: sync.recovered,
    });
  } catch (error) {
    console.error("[Health Attention Sync Error]", error);
    return api.internal();
  }
}
