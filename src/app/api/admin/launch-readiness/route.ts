// =============================================================================
// GENHUB - GET /api/admin/launch-readiness
//
// "What is still missing before real users?" — the same question
// `npm run preflight:prod` answers, asked from inside the panel so an operator
// without a shell can see the list, and asked of the DEPLOYMENT's own
// environment so it cannot disagree with what is actually serving.
//
// ADMIN only, and read-only: it inspects configuration and touches no network,
// no database and no provider. That is why it is a GET with no probes — the
// System readiness card loads on page open, and a card that opens seven
// connections on load is a card that is slow every time somebody glances at it.
// The live half lives in runLiveProbes(), which the setup tab already runs.
//
// The response names environment variables that are MISSING and never values
// that are set. See src/lib/launch-readiness.ts for what is deliberately not
// checked here (entropy, the lockfile, anything that describes a checkout
// rather than a deployment).
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { launchReadiness } from "@/lib/launch-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");
    return api.success(launchReadiness());
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Launch Readiness Error]", error);
    return api.internal();
  }
}
