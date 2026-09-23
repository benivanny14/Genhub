// =============================================================================
// GENHUB - Cron Worker: Poll Video Encoding
// GET/POST /api/cron/poll-encoding
//
// Bunny transcodes in the background, so videos held back from publication need
// something to notice when they become playable. This worker is that something.
//
// It is not the only path on purpose: /api/creator/videos also polls a creator's
// own pending uploads on read, so the lifecycle still completes on a deployment
// where no scheduler is configured. Run this every 2-5 minutes when one is.
//
// Idempotent: a video already notified is never notified again, and publication
// only ever flips unpublished -> published.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { describeEncoding, runWorkerNow } from "@/lib/services/cron-jobs.service";

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  // One shared rule for every cron route: header-only secret, timing-safe
  // compare, fail closed in production. See lib/cron-auth.ts.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const outcome = await runWorkerNow("poll-encoding");

    if (!outcome.ran) {
      console.log(`[Cron] Encoding poll skipped: ${outcome.reason}`);
      return NextResponse.json({
        status: "skipped",
        reason: outcome.reason,
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[Cron] Encoding poll: ${describeEncoding(outcome.result)}, ${outcome.result.ready} ready`
    );

    return NextResponse.json({
      status: "ok",
      ...outcome.result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron] Encoding poll error:", error);
    return NextResponse.json({ error: "Encoding poll failed" }, { status: 500 });
  }
}
