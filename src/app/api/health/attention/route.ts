// =============================================================================
// GENHUB - Health detail, for the alert that has to name the worker
// GET /api/health/attention
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
// Read-only by construction: no lock, no heartbeat, nothing moved. That is also
// why it is NOT under /api/cron — every route in that tree is a worker trigger
// and is required by a test to run through runWorkerNow(), and weakening that
// rule to fit a read would be the wrong trade.
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
