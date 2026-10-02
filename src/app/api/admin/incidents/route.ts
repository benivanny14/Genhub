// =============================================================================
// GENHUB - Admin incident timeline
//
// GET /api/admin/incidents — one chronological feed of the two things an
// operator needs while something is wrong: what admins did (AdminAuditLog) and
// what happened to money (PaymentEvent). The severity rule and the ordering live
// in lib/incident-timeline.ts, where they are tested; this route only fetches.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  incidentCounts,
  mergeIncidentTimeline,
  severityForAuditAction,
  severityForPaymentKind,
  type IncidentEntry,
  type IncidentSeverity,
} from "@/lib/incident-timeline";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const params = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit")) || 200, 1), 500);
    // A severity filter is applied after the merge, because severity is derived
    // rather than a column — asking the database for "warning" is not possible
    // without duplicating the rule.
    const minSeverity = params.get("severity") as IncidentSeverity | null;

    const [audits, payments] = await Promise.all([
      prisma.adminAuditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.paymentEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 300,
        include: {
          transaction: { select: { id: true, userId: true, amount: true } },
        },
      }),
    ]);

    // The actors are resolved by hand: actorId is deliberately not a relation,
    // so a deleted admin leaves their actions readable.
    const actorIds = Array.from(new Set(audits.map((a) => a.actorId).filter(Boolean)));
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    const entries: IncidentEntry[] = [
      ...audits.map((a) => ({
        id: `audit:${a.id}`,
        source: "admin" as const,
        code: a.action,
        summary: a.summary,
        severity: severityForAuditAction(a.action),
        createdAt: a.createdAt.toISOString(),
        actor: actorById.get(a.actorId)?.displayName ?? actorById.get(a.actorId)?.email ?? null,
        targetId: a.targetId,
        detail: a.detail ?? null,
      })),
      ...payments.map((p) => ({
        id: `payment:${p.id}`,
        source: "payment" as const,
        code: p.kind,
        summary: p.detail ?? p.kind,
        severity: severityForPaymentKind(p.kind),
        createdAt: p.createdAt.toISOString(),
        actor: null,
        targetId: p.transactionId,
        detail: {
          ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}),
          amount: p.transaction?.amount ?? null,
          userId: p.transaction?.userId ?? null,
        },
      })),
    ];

    let merged = mergeIncidentTimeline(entries, limit);
    if (minSeverity) {
      const floor = { info: 0, notice: 1, warning: 2, critical: 3 }[minSeverity];
      if (typeof floor === "number") {
        const rank = { info: 0, notice: 1, warning: 2, critical: 3 };
        merged = merged.filter((e) => rank[e.severity] >= floor);
      }
    }

    return api.success({
      entries: merged,
      counts: incidentCounts(entries),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin Incidents Error]", error);
    return api.internal();
  }
}
