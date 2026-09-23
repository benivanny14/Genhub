// =============================================================================
// GENHUB - Cron Worker: Reconcile Stale Payments
// GET/POST /api/cron/reconcile-payments
//
// Asks the gateway about every checkout that is still PENDING, settles whatever
// has completed or failed, and moves anything that never settled past the hard
// TTL to UNDER_INVESTIGATION (a charge that may have taken the customer's money
// and needs a human — deliberately not FAILED, which would invite a retry).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { describeReconcile, runWorkerNow } from "@/lib/services/cron-jobs.service";

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  // One shared rule for every cron route: header-only secret, timing-safe
  // compare, fail closed in production. See lib/cron-auth.ts for why the
  // `?secret=` query form was removed.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // A silently dead reconciler is the failure mode this endpoint exists to
    // prevent, so its own liveness is recorded rather than assumed.
    const outcome = await runWorkerNow("reconcile-payments");

    if (!outcome.ran) {
      console.log(`[Cron] Payment reconciliation skipped: ${outcome.reason}`);
      return NextResponse.json({
        status: "skipped",
        reason: outcome.reason,
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[Cron] Payments reconciled: ${describeReconcile(outcome.result)}, ` +
        `${outcome.result.settledFailed} failed`
    );

    return NextResponse.json({
      status: "ok",
      ...outcome.result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Payment reconciliation error:", error);
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 500 });
  }
}
