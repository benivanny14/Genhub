// =============================================================================
// GENHUB - Cron: Weekly creator earnings digest
// GET/POST /api/cron/earnings-digest
// Emails creators whose earnings cleared the 14-day holding period this week,
// and what is still held. Safe to call often: the worker sends at most one
// digest per creator per seven days, so a schedule that fires hourly mostly
// finds nobody due. Run it from the cron supervisor (the schedule it names in
// the registry) with header `x-cron-secret: $CRON_SECRET`.
// Auth: CRON_SECRET via `Authorization: Bearer` or `x-cron-secret` header only —
// a query-string secret would be written to access logs. Rule in lib/cron-auth.ts.
// =============================================================================

import { NextRequest } from "next/server";
import { api } from "@/lib/api-response";
import { cronOrigin, requireCronSecret } from "@/lib/cron-auth";
import { runWorkerNow } from "@/lib/services/cron-jobs.service";

async function handle(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // Through runWorkerNow, so the run holds the worker's lock and stamps the
    // heartbeat like every other worker — a route that called the service
    // directly would move data with nobody able to see that it ran.
    const outcome = await runWorkerNow("earnings-digest", {
      origin: cronOrigin(request),
    });

    if (!outcome.ran)
      return api.success({ skipped: true, reason: outcome.reason }, outcome.reason);

    return api.success(outcome.result, outcome.summary ?? undefined);
  } catch (error) {
    console.error("[Cron Earnings Digest Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
