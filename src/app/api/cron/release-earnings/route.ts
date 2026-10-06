// =============================================================================
// GENHUB - Cron: Release Matured Earnings
// GET/POST /api/cron/release-earnings
// LEGACY. There is no holding period any more — creator earnings are credited to
// availableBalance the moment a sale settles — so this normally has nothing to
// do. It remains scheduled only to clear a balance left over from before that
// change. Schedule every hour (Vercel Cron, GitHub Actions, or any external
// scheduler) with header `x-cron-secret: $CRON_SECRET`.
// Auth: CRON_SECRET via `Authorization: Bearer` or `x-cron-secret` header
// only — a query-string secret would be written to access logs. Refuses to run
// unprotected in production. Rule lives in lib/cron-auth.ts.
// =============================================================================

import { NextRequest } from "next/server";
import { api } from "@/lib/api-response";
import { cronOrigin, requireCronSecret } from "@/lib/cron-auth";
import { runWorkerNow } from "@/lib/services/cron-jobs.service";

async function handle(request: NextRequest) {
  // One shared rule for every cron route: header-only secret, timing-safe
  // compare, fail closed in production. See lib/cron-auth.ts for why the
  // `?secret=` query form was removed.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // runWorkerNow holds the worker's run lock and stamps the heartbeat, so
    // this route cannot run the same job twice at once, and the admin dashboard
    // learns what happened. Wording lives with the job, not here.
    const outcome = await runWorkerNow("release-earnings", { origin: cronOrigin(request) });

    // Another trigger got there first. Not a failure: answering 500 here would
    // page someone about a job that is running fine.
    if (!outcome.ran) return api.success({ skipped: true, reason: outcome.reason }, outcome.reason);

    return api.success(outcome.result, outcome.summary ?? undefined);
  } catch (error) {
    console.error("[Cron Release Earnings Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
