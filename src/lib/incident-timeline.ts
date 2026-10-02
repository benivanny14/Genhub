// =============================================================================
// GENHUB - The incident timeline
//
// During an incident the operator asks one question: "what just happened, in
// order?" The answers are already on disk but scattered — admin actions live in
// AdminAuditLog, and the money side lives in PaymentEvent. Reading them means
// opening two screens and interleaving them in your head, which is the moment
// someone concludes the system forgot something.
//
// This module is the interleaving, and the part that can be tested on its own:
// a pure severity classifier and a pure merge. The route only fetches the two
// sources and hands them here — so the ordering and the "is this bad?" rule have
// one home.
//
// Severity is derived, never stored: a `payout.approve` is routine, a
// `settled.failed` is not, and both carry the same shape of row. Turning that
// into a colour at read time means tightening the rule later reclassifies the
// whole history instead of only new rows.
// =============================================================================

export type IncidentSeverity = "info" | "notice" | "warning" | "critical";

export interface IncidentEntry {
  id: string;
  /** Where it came from, for the badge and the source link. */
  source: "admin" | "payment";
  /** Dotted code (audit action or payment event kind). */
  code: string;
  summary: string;
  severity: IncidentSeverity;
  createdAt: string;
  /** Who acted, when the source knows. */
  actor: string | null;
  /** Related target / transaction, when known. */
  targetId: string | null;
  detail: unknown;
}

/**
 * The badness of an admin action.
 *
 * Everything not called out is routine. Only money leaks, account removals and
 * suspensions are elevated — an operator filtering a timeline should see the
 * handful of rows that can cost money or a user, not every verification.
 */
export function severityForAuditAction(action: string): IncidentSeverity {
  const code = (action || "").toLowerCase();

  // Money leaving, or a payment handed a human verdict.
  if (
    code === "payment.refund" ||
    code === "payment.grant" ||
    code === "payment.expire"
  ) {
    return "critical";
  }
  // A suspension or a deletion is a person's account changing state.
  if (code === "user.ban" || code === "user.delete") return "critical";
  if (code === "user.unban" || code === "payout.freeze" || code === "payout.unfreeze") {
    return "warning";
  }
  if (code === "user.warn" || code === "video.delete" || code === "report.resolve") {
    return "warning";
  }
  // A platform-wide switch changes what everyone can do; worth noticing.
  if (code === "videos.all_free" || code === "videos.paid" || code === "platform.toggle") {
    return "notice";
  }
  if (code === "user.free_access" || code === "user.revoke_free_access") return "notice";
  if (code.startsWith("payout.")) return "notice";
  return "info";
}

/**
 * The badness of a payment event.
 *
 * `investigation.open` is critical on purpose: it is the one state where a
 * customer's money may or may not have moved and nobody knows yet. `settled.*`
 * success is routine, failure is not.
 */
export function severityForPaymentKind(kind: string): IncidentSeverity {
  const code = (kind || "").toLowerCase();
  if (
    code === "collect.failed" ||
    code === "collect.rejected" ||
    code === "settled.failed" ||
    code === "collect.expired" ||
    code === "checkout.expired"
  ) {
    return "warning";
  }
  if (code === "investigation.open") return "critical";
  if (code === "admin.action") return "notice";
  return "info";
}

const RANK: Record<IncidentSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
};

/** Newest first; ties broken by severity so two same-second rows read sensibly. */
export function mergeIncidentTimeline(
  entries: IncidentEntry[],
  limit = 200
): IncidentEntry[] {
  return [...entries]
    .sort((a, b) => {
      const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (byTime !== 0) return byTime;
      return RANK[b.severity] - RANK[a.severity];
    })
    .slice(0, Math.max(1, limit));
}

/** Counts by severity, for the summary chips above the timeline. */
export function incidentCounts(
  entries: IncidentEntry[]
): Record<IncidentSeverity, number> {
  const counts: Record<IncidentSeverity, number> = {
    info: 0,
    notice: 0,
    warning: 0,
    critical: 0,
  };
  for (const entry of entries) counts[entry.severity] += 1;
  return counts;
}
