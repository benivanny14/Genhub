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
import { reconcileStalePayments } from "@/lib/services/payment-reconcile.service";

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
    const result = await reconcileStalePayments();

    console.log(
      `[Cron] Payments reconciled: ${result.checked} checked, ` +
        `${result.settledSuccess} settled, ${result.settledFailed} failed, ` +
        `${result.underInvestigation} newly flagged, ` +
        `${result.awaitingResolution} awaiting resolution, ` +
        `${result.stillProcessing} still processing`
    );

    return NextResponse.json({
      status: "ok",
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Payment reconciliation error:", error);
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 500 });
  }
}
