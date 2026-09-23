// =============================================================================
// GENHUB - Bunny Upload Pipeline Self-Test
// POST /api/admin/bunny-self-test - ADMIN only
//
// Deliberately NOT part of the Setup tab's "Re-check" sweep: this creates and
// deletes a real video object in the live Bunny library, so a page load must not
// trigger it. It is a button an operator presses on purpose.
//
// It exists because a valid API key is not proof uploads work. This library once
// answered 200 to every management call and accepted a 5.5 MB upload with both
// PUT and TUS, then stored 0 bytes and never advanced — the kind of failure a
// key check reports as healthy and a creator discovers by losing their upload.
//
// The probe video is deleted even when the test fails. See
// runBunnyPipelineSelfTest in lib/services/video-encoding.service.ts.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { runBunnyPipelineSelfTest } from "@/lib/services/video-encoding.service";

// Uses the Bunny SDK helpers (node:crypto) — Node runtime, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    await requireRole("ADMIN");

    const result = await runBunnyPipelineSelfTest();

    // A failed verdict is a valid answer about the account, not a server error,
    // so it still returns 200 with the detail the operator needs to act on.
    return api.success(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Bunny Self-Test Error]", error);
    return api.internal();
  }
}
