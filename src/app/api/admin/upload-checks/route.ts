// =============================================================================
// GENHUB - What creators' phones reported they could reach
// GET /api/admin/upload-checks - ADMIN only
//
// The list beside the failed uploads: one row per creator, from the last time
// they ran the network check on the device that was failing. The verdict only
// exists on the phone — a browser tells the page nothing about why a cross-origin
// request failed, and the server never sees the request at all — so this is the
// endpoint that turns it into something the person who can fix it can read.
//
// Read-only and cache-backed, so it costs nothing to call on every visit to the
// Setup tab, exactly like the failure list and the "Bunny webhook" probe.
//
// AN EMPTY LIST IS A TRUE ANSWER, not an error: nobody has needed to run the
// check since the deployment started recording.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { listUploadChecks } from "@/lib/services/upload-check.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const checks = await listUploadChecks();

    return api.success({ checks });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Upload Checks Error]", error);
    return api.internal();
  }
}
