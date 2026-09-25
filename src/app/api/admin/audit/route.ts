// =============================================================================
// GENHUB - GET /api/admin/audit
//
// The read side of the audit log: newest first, optionally narrowed to one
// action code, one actor or one target. Writes happen through
// recordAudit() in the routes that perform the action — there is no POST here
// on purpose: an audit row a client can create by hand is not evidence.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { listAuditLog } from "@/lib/services/audit.service";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const params = request.nextUrl.searchParams;
    const take = Number.parseInt(params.get("take") || "100", 10);

    const entries = await listAuditLog({
      action: params.get("action") || undefined,
      actorId: params.get("actorId") || undefined,
      targetId: params.get("targetId") || undefined,
      take: Number.isFinite(take) ? take : 100,
    });

    return api.success({ entries });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Audit Log Error]", error);
    return api.internal();
  }
}
