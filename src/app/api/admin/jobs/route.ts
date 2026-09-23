// =============================================================================
// GENHUB - Admin: background job liveness
// GET /api/admin/jobs
//
// Answers "is anything still running?" for the four scheduled workers. Each one
// stamps a heartbeat as it runs (lib/services/cron-heartbeat.service.ts), so a
// schedule that stopped firing shows up as a worker that has not finished
// anything inside its expected cadence — instead of as silence.
//
// Admin only: the payload names internal capabilities and their cadence.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { getCronHealth } from "@/lib/services/cron-heartbeat.service";

export async function GET(_request: NextRequest) {
  try {
    await requireRole("ADMIN");

    // Deliberately NOT cached, unlike /api/admin/overview. A cached answer to
    // "has anything stopped running" would keep reporting healthy for as long
    // as the cache lives — the exact window in which someone is looking here
    // because they suspect a problem.
    const health = await getCronHealth();

    return api.success(health);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Jobs Error]", error);
    return api.internal();
  }
}
