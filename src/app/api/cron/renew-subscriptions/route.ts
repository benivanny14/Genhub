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
import {
  previewDueRenewals,
  summarizeRenewalPreview,
} from "@/lib/services/subscription-renewal.service";

/**
 * `?dryRun=1` (or `{"dryRun":true}` on a POST) asks what a real run would charge.
 *
 * This is the question the supervisor cannot answer for itself: it refuses to
 * start this worker because a USSD push lands on a fan's phone, which leaves the
 * person who has to press "Run now" deciding blind. The preview writes nothing —
 * no transaction, no attempt counter, no notification, no prompt — and takes no
 * run lock and no heartbeat slot, because the heartbeat is the record of what
 * moved money and nothing here moves any. A dry run that claimed the slot would
 * also hide the worker from the overdue alarm, which is the one thing that makes
 * somebody press the button at all.
 */
function queryWantsDryRun(request: NextRequest): boolean {
  const query = (request.nextUrl.searchParams.get("dryRun") || "").toLowerCase();
  return query === "1" || query === "true";
}

function bodyWantsDryRun(body: unknown): boolean {
  return (body as { dryRun?: unknown } | null)?.dryRun === true;
}

async function handle(request: NextRequest) {
  // One shared rule for every cron route: header-only secret, timing-safe
  // compare, fail closed in production. See lib/cron-auth.ts for why the
  // `?secret=` query form was removed.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // A GET has no body and a POST without one is the ordinary scheduled call, so
    // the body is parsed only when the query has not already answered: a POST that
    // does not ask to be a dry run must reach the runner exactly as it did before.
    const body = queryWantsDryRun(request) ? null : await request.json().catch(() => null);

    if (queryWantsDryRun(request) || bodyWantsDryRun(body)) {
      const preview = await previewDueRenewals();
      return api.success({ dryRun: true, ...preview }, summarizeRenewalPreview(preview));
    }

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
