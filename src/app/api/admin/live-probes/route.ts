// =============================================================================
// GENHUB - Live probes for the admin Overview card
// GET /api/admin/live-probes (ADMIN)
//
// The Overview readiness card used to render what `/api/payments/health`
// *reports about its configuration* — "apiKey: configured" — which is a fact
// about a string, not about SonicPesa. A revoked key is still "configured", and
// that is exactly how a dead gateway was reported as healthy.
//
// This asks the OTHER question, the one `runLiveProbes()` already answers for
// the Setup tab and the watchdog: open the connection and show what came back.
// The SonicPesa probe mints a real token, so the card shows one of
//   valid · authorization token issued
//   HTTP 403 - SONICPESA_ACCESS_KEY were rejected
//   <host> did not resolve / aborted ...
//
// It is a separate route from /api/payments/health on purpose: the SonicPesa
// probe can take tens of seconds on a cold connection, and a card that already
// has fast config checks should not wait behind it.
//
// Behind an admin session only. The probe result names environment variables
// and hosts, which is operator information, not public.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { runLiveProbes } from "@/lib/setup-check";
import { getMigrationStatus } from "@/lib/migrations-status";

// node:fs, nodemailer, ioredis and prisma all need the Node runtime.
export const runtime = "nodejs";
// The SonicPesa probe's two budgets must fit inside this (15s + 12s).
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const [probes, migrations] = await Promise.all([
      runLiveProbes(),
      getMigrationStatus(),
    ]);

    return api.success({ probes, migrations });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Live Probes Error]", error);
    return api.internal();
  }
}
