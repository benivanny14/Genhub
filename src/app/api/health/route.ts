// =============================================================================
// GENHUB - Health Check API
// GET /api/health
//
// Two audiences, two payloads, one route:
//
//   * ANONYMOUS (an uptime monitor, a stranger, a scanner): `{ status }` and
//     nothing else. The old answer published the environment name, which mail,
//     SMS and payment providers were configured, whether Bunny was set up, the
//     names of the environment variables that were missing, the background-job
//     verdict, and every production config warning — a complete map of the
//     deployment's internals to anyone who asked. None of that is needed to
//     answer "is this app up", which is the only question a stranger is entitled
//     to ask.
//
//   * ADMIN SESSION or CRON_SECRET: the full diagnostic payload, unchanged, so
//     the admin System tab and the post-deploy/uptime tooling keep everything
//     they had. Diagnostics are not gone, they are behind a door.
//
// The public verdict is also the CHEAP one, on purpose. It asks the database
// `SELECT 1` — the single question that decides "up" — and memoises the answer
// for a few seconds, so a monitor polling every five seconds cannot turn this
// endpoint into load. Schema, worker liveness and configuration warnings are
// explicitly NOT part of the public answer: they are the expensive reads, and
// they are the ones that describe how the deployment is built.
//
// `Cache-Control: no-store` on both: a cached "ok" is the one thing a health
// endpoint must never serve after the database has gone away.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config, { productionConfigWarnings, uploadStorageReadiness } from "@/lib/config";
import { requireCronSecret } from "@/lib/cron-auth";
import { getCurrentUser } from "@/lib/auth";
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
 * How long a public verdict is reused.
 *
 * Long enough that polling cannot become load (a 15 s window turns a monitor
 * polling every 5 s into one database round trip per 15 s), short enough that a
 * database that has just gone away is still reported as down by the next poll.
 */
const PUBLIC_VERDICT_TTL_MS = 15_000;

/** The memo for that window. Per instance, and it never outlives the process. */
let publicVerdict: { at: number; status: "ok" | "degraded" } | null = null;

/**
 * The only question the public answer needs: is the database reachable?
 *
 * Deliberately not the schema check, not the worker check and not the config
 * audit. Those describe the deployment; this describes whether it is up.
 */
async function publicStatus(): Promise<"ok" | "degraded"> {
  if (publicVerdict && Date.now() - publicVerdict.at < PUBLIC_VERDICT_TTL_MS) {
    return publicVerdict.status;
  }
  let status: "ok" | "degraded" = "degraded";
  try {
    await prisma.$queryRaw`SELECT 1`;
    status = "ok";
  } catch {
    status = "degraded";
  }
  publicVerdict = { at: Date.now(), status };
  return status;
}

/**
 * May this caller see the deployment's internals?
 *
 * Two signals, both server-side: the shared secret the schedules and the
 * watchdog already carry (see lib/cron-auth), and a live ADMIN session read from
 * the database — never a role claim taken from a token or a header.
 */
async function mayReadDiagnostics(request: NextRequest): Promise<boolean> {
  if (requireCronSecret(request) === null) return true;
  try {
    const user = await getCurrentUser();
    return user?.role === "ADMIN";
  } catch {
    // A cookie we cannot verify is not a reason to fail the health check; it is
    // a reason to answer the public version.
    return false;
  }
}

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

/**
 * Everything the operator needs, for the operator only.
 *
 * Same payload the endpoint used to publish to the world — including the config
 * warnings and the missing-variable names, which is exactly why it is no longer
 * world-readable.
 */
async function diagnostics() {
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

  return {
    status: healthy ? ("ok" as const) : ("degraded" as const),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    nodeEnv: config.nodeEnv,
    checks: {
      database,
      schema,
      email: config.email.host ? "smtp" : "console",
      sms: config.sms.apiKey ? "africastalking" : "console",
      // "sandbox" = no USSD push and no real money moves (dev default)
      payments: config.clickPesa.sandbox ? "sandbox" : "live",
      bunny: config.bunny.apiKey ? "configured" : "missing",
      // The names of the Bunny Stream variables this deployment is missing,
      // never a value. Video uploads and playback both need them, and a
      // deployment with neither set used to publish no warning at all — the
      // warning was a comparison between two flags rather than a floor.
      uploadStorage: {
        bunny: uploadStorage.bunnyConfigured,
        missing: uploadStorage.missing,
      },
      backgroundJobs,
    },
    warnings,
    timestamp: new Date().toISOString(),
  };
}

export async function GET(request: NextRequest) {
  if (await mayReadDiagnostics(request)) {
    const detail = await diagnostics();
    return Response.json(detail, {
      status: detail.status === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  const status = await publicStatus();
  // `status` alone. No environment, no provider names, no variable names, no
  // worker names, no warnings, no build or uptime information — nothing about
  // how this deployment is built, which is all anybody anonymous needs.
  return Response.json(
    { status },
    {
      status: status === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    }
  );
}
