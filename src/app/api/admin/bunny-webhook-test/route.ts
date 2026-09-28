// =============================================================================
// GENHUB - Bunny Stream webhook self-test
// POST /api/admin/bunny-webhook-test - ADMIN only
//
// The receiving half of instant publishing, tested against the live deployment:
// one correctly signed callback is posted to this app's own
// /api/webhooks/bunny, and one forged callback to prove the rule refuses it.
//
// Deliberately NOT part of the Setup tab's Re-check sweep — it makes two real
// HTTP requests to the public URL, so it is a button an operator presses. The
// automatic half of the same question is the "Bunny webhook" probe (does the
// secret exist, and when did a real callback last arrive — see
// lib/setup-check.ts and lib/services/bunny-webhook.service.ts).
//
// The callback names an id that owns no video and carries Status 3 (Finished),
// so it travels the publishing path without being able to publish anything.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { runBunnyWebhookSelfTest } from "@/lib/services/bunny-webhook.service";

// Calls the app's own public URL — Node runtime, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    await requireRole("ADMIN");

    const result = await runBunnyWebhookSelfTest();

    // A missing secret or a refused endpoint is a true answer about the setup,
    // not a server error, so it is a 200 with the steps that led to it.
    return api.success(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Bunny Webhook Self-Test Error]", error);
    return api.internal();
  }
}
