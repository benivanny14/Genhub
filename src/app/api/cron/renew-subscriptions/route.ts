// =============================================================================
// GENHUB - Cron: Renew Subscriptions
// GET/POST /api/cron/renew-subscriptions
//
// Charges memberships that are about to expire (wallet first, then a HarakaPay
// USSD push), retries failures with a gap, and notifies the fan. Schedule this
// every hour (Vercel Cron, GitHub Actions, or any external scheduler) with
// header `x-cron-secret: $CRON_SECRET`.
//
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
    // This worker is the one that can charge a fan who did not ask: when a
    // wallet cannot cover a renewal it sends a USSD push. The run lock in
    // runWorkerNow is what stops a second scheduler from pushing twice.
    const outcome = await runWorkerNow("renew-subscriptions", { origin: cronOrigin(request) });

    if (!outcome.ran) return api.success({ skipped: true, reason: outcome.reason }, outcome.reason);

    return api.success(outcome.result, outcome.summary ?? undefined);
  } catch (error) {
    console.error("[Cron Renew Subscriptions Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
