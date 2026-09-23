// =============================================================================
// GENHUB - Health Check API
// GET /api/health - Lightweight status endpoint for uptime monitors and
// post-deploy verification. Reports database reachability, whether the
// background workers are still running on schedule, and any production
// configuration warnings (never secret values).
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config, { productionConfigWarnings } from "@/lib/config";
import { getCronHealth, summarizeCronHealth } from "@/lib/services/cron-heartbeat.service";

// Without this, Next prerenders this route at build time — it reads no cookies
// or headers, so nothing marks it dynamic. It was the only API route in the
// project served statically (`o` in the build output, 69 others `f`). A cached
// snapshot is the one thing a health endpoint must never be: an uptime monitor
// would poll it forever and always get whatever the database said during the
// build — including a permanently degraded answer if the database was not
// reachable then. Workers' liveness lives here, so it has to be read live.
export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET(_request: NextRequest) {
  let database: "up" | "down" = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "up";
  } catch {
    database = "down";
  }

  // Background workers. Exposed here because an uptime monitor is the only
  // thing watching when nobody has the dashboard open — which is exactly the
  // window a stopped schedule hides in. Only the verdict is public, never the
  // worker detail.
  let backgroundJobs: ReturnType<typeof summarizeCronHealth> | "unknown" = "unknown";
  try {
    backgroundJobs = summarizeCronHealth(await getCronHealth());
  } catch {
    // Leave it "unknown" rather than claiming health we could not read.
  }

  const warnings = productionConfigWarnings();

  // Degraded only when something that *was* running has gone quiet. A worker
  // that has never run means no scheduler is configured yet, which is setup
  // work, not an outage — folding that in would make every fresh deploy report
  // 503 until someone wires a scheduler, and an alarm that is always red is an
  // alarm nobody reads.
  const jobsDegraded =
    backgroundJobs === "late" || backgroundJobs === "stalled" || backgroundJobs === "failing";
  const healthy = database === "up" && !jobsDegraded;

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      nodeEnv: config.nodeEnv,
      checks: {
        database,
        email: config.email.host ? "smtp" : "console",
        sms: config.sms.apiKey ? "africastalking" : "console",
        // "sandbox" = no USSD push and no real money moves (dev default)
        payments: config.harakaPay.sandbox ? "sandbox" : "live",
        bunny: config.bunny.apiKey ? "configured" : "missing",
        backgroundJobs,
      },
      warnings,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
