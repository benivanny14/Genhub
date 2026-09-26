// =============================================================================
// GENHUB - Admin: blue tick requests
// GET  /api/admin/blue-tick  - requests waiting for a decision + recent ones
// POST /api/admin/blue-tick  - { requestId, action: "APPROVE" | "REJECT", reason? }
//
// Approval is the only thing that puts the badge on a profile: paying creates
// the request, an admin grants the month. Rejection refunds, and both decisions
// are written to the admin audit log — the log answers "who gave this creator a
// badge, and when" long after the row itself has been renewed past recognition.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import {
  approveBlueTick,
  listBlueTickRequests,
  rejectBlueTick,
} from "@/lib/services/blue-tick.service";

export async function GET(_request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const data = await listBlueTickRequests();
    return api.success(data);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Blue Tick List Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json().catch(() => ({}));
    const requestId = body?.requestId?.toString();
    const action = body?.action?.toString();
    const reason = body?.reason?.toString().slice(0, 500);

    if (!requestId) return api.validation("requestId is required");
    if (action !== "APPROVE" && action !== "REJECT") {
      return api.validation("action must be APPROVE or REJECT");
    }

    const result =
      action === "APPROVE"
        ? await approveBlueTick({ requestId, adminId: auth.userId })
        : await rejectBlueTick({ requestId, adminId: auth.userId, reason });

    if (!result.ok) {
      return result.reason === "NOT_FOUND"
        ? api.notFound("Blue tick request not found")
        : api.error("This request has already been reviewed");
    }

    await recordAudit({
      actorId: auth.userId,
      action:
        action === "APPROVE" ? AUDIT_ACTIONS.blueTickApprove : AUDIT_ACTIONS.blueTickReject,
      targetType: "BlueTickRequest",
      targetId: requestId,
      summary:
        action === "APPROVE"
          ? `Approved a blue tick for TZS ${result.amount.toLocaleString()} until ${result.expiresAt}`
          : `Rejected a blue tick request for TZS ${result.amount.toLocaleString()}${
              reason ? ` — ${reason}` : ""
            } (refunded)`,
      detail: {
        userId: result.userId,
        amount: result.amount,
        expiresAt: result.expiresAt,
        refunded: result.refunded,
        reason: reason ?? null,
      },
    });

    return api.success(
      result,
      action === "APPROVE" ? "Blue tick approved" : "Request rejected and refunded"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Blue Tick Action Error]", error);
    return api.internal();
  }
}
