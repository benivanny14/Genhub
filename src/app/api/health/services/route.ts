// =============================================================================
// GENHUB - Live service probes, for the alarm rather than a person
// GET /api/health/services
//
// `npm run preflight:prod` asks these questions from a laptop, which is exactly
// the problem: a credential that rots in production — a Bunny key revoked, an
// SMTP password rotated, a Redis token replaced, the database suspended — is
// only noticed the next time somebody remembers to run the gate by hand. The
// site keeps answering every request perfectly while it cannot take money, send
// a password reset or cache anything.
//
// So the same probes the admin Setup tab runs are exposed here, behind the
// CRON_SECRET the schedules already carry, and the hourly watchdog asks for them
// on every run. A configured-but-broken service then raises the alarm the
// repo already has (a failed scheduled run → email, plus ALERT_WEBHOOK_URL if
// set) instead of waiting for a human.
//
// Deliberately NOT under /api/cron: every route in that tree is a worker trigger
// and is required by a test to run through runWorkerNow(). This reads and moves
// nothing — the same reason /api/health/attention lives here.
//
// `skip` is not a failure. A service nobody has configured yet is the launch
// checklist's business, not the watchdog's, and treating it as an outage would
// keep every pre-launch deployment permanently red — which is how an alarm stops
// being read.
// =============================================================================

import { NextRequest } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { api } from "@/lib/api-response";
import { runLiveProbes } from "@/lib/setup-check";

// Prisma, ioredis, nodemailer and node:fs all need the Node runtime.
export const runtime = "nodejs";
// The probes open real connections, and the slowest of them (a managed Postgres
// waking from idle) can take seconds. Without this the function can be killed
// mid-probe, and a killed function answers the watchdog the same way an
// unreachable one does — which would silence the alarm this route exists for.
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const probes = await runLiveProbes();

    const failing = probes.filter((p) => p.state === "fail");
    const skipped = probes.filter((p) => p.state === "skip");

    return api.success({
      verdict: failing.length > 0 ? "degraded" : "ok",
      // Only what needs somebody, in the shape the watchdog's alert reads.
      failing: failing.map((p) => ({ id: p.id, name: p.name, detail: p.detail })),
      // Named so an operator can tell "not configured yet" from "working".
      skipped: skipped.map((p) => p.id),
      probes,
    });
  } catch (error) {
    // "Is the deployment's configuration still working" failing must never read
    // as "everything is fine": the caller gets an error and falls back to the
    // verdict it already had.
    console.error("[Health Services Error]", error);
    return api.internal();
  }
}
