// =============================================================================
// GENHUB - Cron: refresh video encoding state
// GET/POST /api/cron/video-encoding
//
// The safety net under the Bunny callback. Readiness is decided by "can Bunny
// serve this yet", and the webhook is the fast path that answers it the instant
// an encode finishes — but a callback can be missed (Bunny retries, and still
// gives up), can arrive before the row exists, or can fail transiently and
// answer 5xx. When that happens nothing on the creator's side notices: the post
// is published the moment it is uploaded, marked "Inachakatwa...", and it would
// simply stay marked forever.
//
// So this worker walks the videos still carrying an encoding status, asks Bunny
// for each one's real state, and publishes the ones that are finished. It goes
// through refreshVideoEncoding() — the same function the webhook and every page
// read uses — so publication, the re-check floor and the once-only notification
// cannot drift between the push path and this pull path.
//
// Bounded on purpose: nine videos per run, three Bunny lookups at a time (see
// refreshPendingVideoEncodings). The schedule it names in the registry is a
// dedicated poke, and /api/cron/supervisor runs it too — a safe worker left out
// of the supervisor is one that silently stops when its own file is not
// delivered.
//
// Auth: CRON_SECRET via `Authorization: Bearer` or `x-cron-secret` header only —
// a query-string secret would be written to access logs. Rule in lib/cron-auth.ts.
// =============================================================================

import { NextRequest } from "next/server";
import { api } from "@/lib/api-response";
import { cronOrigin, requireCronSecret } from "@/lib/cron-auth";
import { runWorkerNow } from "@/lib/services/cron-jobs.service";

export const runtime = "nodejs";
// Each run makes up to nine provider calls three at a time; the default budget
// would cut a slow Bunny before it finished.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    // Through runWorkerNow, so the run holds the worker's lock and stamps the
    // heartbeat like every other worker — a route that called the service
    // directly would move state with nobody able to see that it ran.
    const outcome = await runWorkerNow("video-encoding", {
      origin: cronOrigin(request),
    });

    if (!outcome.ran)
      return api.success({ skipped: true, reason: outcome.reason }, outcome.reason);

    return api.success(outcome.result, outcome.summary ?? undefined);
  } catch (error) {
    console.error("[Cron Video Encoding Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
