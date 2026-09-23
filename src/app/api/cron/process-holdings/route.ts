// =============================================================================
// GENHUB - Cron Worker: Process 14-Day Holdings (LEGACY ALIAS)
// GET/POST /api/cron/process-holdings
//
// This endpoint used to run processMaturedHoldings(), a second, independent
// holding-release implementation. Because it tracked maturity with
// HoldingPeriodLog while releaseMatureEarnings() tracks it with
// CreatorBalance.releasedTotal, ever running BOTH would have double-credited
// creators. The logic now lives in exactly one place — this route is a thin
// forwarder so any old cron config pointing here keeps working safely.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { describeReleaseEarnings, runWorkerNow } from "@/lib/services/cron-jobs.service";

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
    // Recorded as "release-earnings", not as a worker of its own: this route
    // runs the same job, so a deployment whose old cron config points here must
    // not leave release-earnings reporting "never ran" forever. The origin is
    // written into the heartbeat, where it tells a future reader which trigger
    // actually did the work.
    const outcome = await runWorkerNow("release-earnings", { origin: "legacy process-holdings route" });

    if (!outcome.ran) {
      return NextResponse.json({
        status: "skipped",
        reason: outcome.reason,
        timestamp: new Date().toISOString(),
      });
    }

    const result = outcome.result;

    console.log(
      `[Cron] Holdings processed (alias): ${describeReleaseEarnings(result)}`
    );

    return NextResponse.json({
      status: "ok",
      // Legacy response shape kept for old consumers
      processedCount: result.creators,
      totalTransferred: result.released,
      released: result.released,
      creators: result.creators,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Holdings processing error:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
