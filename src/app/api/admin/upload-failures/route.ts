// =============================================================================
// GENHUB - GET / DELETE /api/admin/upload-failures
//
// "Did a creator just fail to upload, and why?" — the question the server could
// not answer while the only copy of a failed upload lived in a toast on a phone.
// See lib/services/upload-failure.service.ts for what is stored and why.
//
// ADMIN only. GET is one cheap cache read; DELETE forgets the list, and exists
// so an operator can confirm a fix by watching the panel stay empty rather than
// by scrolling past the failures that prompted it.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { clearUploadFailures, listUploadFailures } from "@/lib/services/upload-failure.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");
    const failures = await listUploadFailures();
    return api.success({ failures, count: failures.length });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Upload Failures Error]", error);
    return api.internal();
  }
}

export async function DELETE() {
  try {
    await requireRole("ADMIN");
    await clearUploadFailures();
    return api.success({ cleared: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Upload Failures Error]", error);
    return api.internal();
  }
}
