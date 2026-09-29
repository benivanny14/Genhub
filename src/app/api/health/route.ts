// =============================================================================
// GENHUB - Health Check API
// GET /api/health - Lightweight status endpoint for uptime monitors and
// post-deploy verification. Reports database reachability, whether the
// background workers are still running on schedule, and any production
// configuration warnings (never secret values).
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config, { productionConfigWarnings, uploadStorageReadiness } from "@/lib/config";
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

/**
 * The video columns this deployment cannot run without, checked by NAME.
 *
 * `SELECT 1` answers "is there a database", which is not the question that
 * matters after a deploy. A build can ship code that reads `uploadSizeBytes` or
 * `bunnyStorageBytes` while the migration that adds them was never applied — and
 * then the database is reachable, the health check is green, and every creator
 * upload fails at the last step with a column-not-found error nobody is looking
 * for. That is exactly how a schema change shipped without its migration on
 * 2026-09-25 (see the header of scripts/db-migrate.mjs).
 *
 * These four are the upload/encoding fields of `Video`: one from the signed
 * upload path and three from the encoding lifecycle. A `select` of them is what
 * makes the check real — Prisma resolves the column list against the deployed
 * schema, so a missing column throws even on an empty table.
 */
const REQUIRED_VIDEO_COLUMNS = [
  "uploadSizeBytes",
  "bunnyStorageBytes",
  "encodingStatus",
  "encodeProgress",
] as const;

export async function GET(_request: NextRequest) {
  let database: "up" | "down" = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "up";
  } catch {
    database = "down";
  }

  // Separate from `database` on purpose: the difference between "cannot reach
  // Postgres" and "reached it, it is the wrong shape" decides whether somebody
  // restarts a service or runs a migration. `take: 1` keeps it one indexed row,
  // and the explicit select is the whole point — the columns are what is checked.
  let schema: "up" | "down" = "down";
  try {
    await prisma.video.findFirst({
      select: { uploadSizeBytes: true, bunnyStorageBytes: true, encodingStatus: true, encodeProgress: true },
      orderBy: { createdAt: "desc" },
    });
    schema = "up";
  } catch {
    schema = "down";
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
  const uploadStorage = uploadStorageReadiness();

  // Named with the command that fixes it: a health check that says "degraded"
  // and stops there costs the operator the ten minutes it takes to find out
  // which of five things is wrong.
  if (schema === "down" && database === "up") {
    warnings.push(
      `The database is missing a video column this build needs (${REQUIRED_VIDEO_COLUMNS.join(
        ", "
      )}) — apply pending migrations with \`npm run db:deploy\`.`
    );
  }

  // Degraded only when something that *was* running has gone quiet. A worker
  // that has never run means no scheduler is configured yet, which is setup
  // work, not an outage — folding that in would make every fresh deploy report
  // 503 until someone wires a scheduler, and an alarm that is always red is an
  // alarm nobody reads.
  const jobsDegraded =
    backgroundJobs === "late" || backgroundJobs === "stalled" || backgroundJobs === "failing";
  // `schema` is part of healthy, not a note beside it: an upload path whose
  // database cannot store the result is not "degraded", it is down for the one
  // thing this deployment exists to do.
  const healthy = database === "up" && schema === "up" && !jobsDegraded;

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      nodeEnv: config.nodeEnv,
      checks: {
        database,
        schema,
        email: config.email.host ? "smtp" : "console",
        sms: config.sms.apiKey ? "africastalking" : "console",
        // "sandbox" = no USSD push and no real money moves (dev default)
        payments: config.harakaPay.sandbox ? "sandbox" : "live",
        bunny: config.bunny.apiKey ? "configured" : "missing",
        // Two flags rather than one verdict, and the names of whatever is
        // absent. The R2 four and the ingest two are set in different consoles,
        // so "the upload path is not configured" costs the reader the ten
        // minutes of checking both — and a deployment with NEITHER half set used
        // to publish no warning at all, because the warning is a comparison
        // between the two flags rather than a floor. These are variable NAMES;
        // no value is ever echoed here.
        uploadStorage: {
          r2: uploadStorage.r2Configured,
          ingest: uploadStorage.ingestConfigured,
          missing: uploadStorage.missing,
        },
        backgroundJobs,
      },
      warnings,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
