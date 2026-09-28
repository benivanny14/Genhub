// =============================================================================
// GENHUB - Failed video uploads
// GET /api/admin/upload-failures - ADMIN only
//
// The list the admin Setup tab shows beside the upload pipeline test: the
// failures that actually happened, with Bunny's own HTTP status and response
// body, newest first.
//
// Read-only and cache-backed, so it costs nothing to call on every visit — the
// same shape as the "Bunny webhook" probe, which reads the last recorded
// callback from the same cache (lib/services/bunny-webhook.service.ts).
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { listUploadFailures } from "@/lib/services/upload-failure.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");

    const failures = await listUploadFailures();

    // An empty list is a true answer, not an error: it means nothing has failed
    // since the deployment started recording, which is the state to hope for.
    return api.success({ failures });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Upload Failures Error]", error);
    return api.internal();
  }
}
