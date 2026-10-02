// =============================================================================
// GENHUB - Incident timeline + signup cohorts (pure)
//
// Two read-only views an operator leans on during an incident and a growth
// review. What matters: the severity rule does not drift by accident, and the
// cohort maths is arithmetic, not vibes.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  severityForAuditAction,
  severityForPaymentKind,
  mergeIncidentTimeline,
  incidentCounts,
  type IncidentEntry,
} from "@/lib/incident-timeline";
import { buildSignupCohorts, weekStart } from "@/lib/cohort-analytics";

describe("incident severity", () => {
  it("treats money leaving and account removals as critical", () => {
    expect(severityForAuditAction("payment.refund")).toBe("critical");
    expect(severityForAuditAction("user.ban")).toBe("critical");
    expect(severityForAuditAction("user.delete")).toBe("critical");
  });

  it("flags a payment investigation as critical, not routine", () => {
    expect(severityForPaymentKind("investigation.open")).toBe("critical");
  });

  it("flags a failed settle or collect as a warning, and success as info", () => {
    expect(severityForPaymentKind("settled.failed")).toBe("warning");
    expect(severityForPaymentKind("collect.rejected")).toBe("warning");
    expect(severityForPaymentKind("settled.success")).toBe("info");
  });

  it("treats a platform-wide switch as worth noticing", () => {
    expect(severityForAuditAction("videos.all_free")).toBe("notice");
    expect(severityForAuditAction("platform.toggle")).toBe("notice");
  });

  it("leaves a routine verification as info", () => {
    expect(severityForAuditAction("kyc.approve")).toBe("info");
  });
});

describe("mergeIncidentTimeline", () => {
  const entry = (
    id: string,
    createdAt: string,
    severity: IncidentEntry["severity"]
  ): IncidentEntry => ({
    id,
    source: "admin",
    code: "x",
    summary: id,
    severity,
    createdAt,
    actor: null,
    targetId: null,
    detail: null,
  });

  it("orders newest first", () => {
    const merged = mergeIncidentTimeline([
      entry("old", "2026-01-01T00:00:00.000Z", "info"),
      entry("new", "2026-01-03T00:00:00.000Z", "info"),
    ]);
    expect(merged.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("breaks a same-second tie by severity", () => {
    const merged = mergeIncidentTimeline([
      entry("calm", "2026-01-01T00:00:00.000Z", "info"),
      entry("loud", "2026-01-01T00:00:00.000Z", "critical"),
    ]);
    expect(merged[0].id).toBe("loud");
  });

  it("honours the limit and counts by severity", () => {
    const merged = mergeIncidentTimeline(
      [
        entry("a", "2026-01-01T00:00:00.000Z", "critical"),
        entry("b", "2026-01-02T00:00:00.000Z", "warning"),
        entry("c", "2026-01-03T00:00:00.000Z", "info"),
      ],
      2
    );
    expect(merged).toHaveLength(2);
    expect(incidentCounts(merged)).toEqual({ info: 1, notice: 0, warning: 1, critical: 0 });
  });
});

describe("buildSignupCohorts", () => {
  const now = new Date("2026-03-30T12:00:00.000Z");

  it("groups accounts by the Monday of their signup week", () => {
    // 2026-03-04 is a Wednesday; its week starts Monday 2026-03-02.
    const start = weekStart(new Date("2026-03-04T09:00:00.000Z"));
    expect(start.toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("counts a cohort's size and how many stayed active", () => {
    const cohorts = buildSignupCohorts(
      [
        { createdAt: "2026-03-04T09:00:00.000Z", lastLoginAt: "2026-03-29T09:00:00.000Z" },
        { createdAt: "2026-03-04T10:00:00.000Z", lastLoginAt: "2026-01-01T00:00:00.000Z" },
        { createdAt: "2026-03-05T10:00:00.000Z", lastLoginAt: null },
      ],
      now,
      { retentionDays: 30 }
    );
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].size).toBe(3);
    expect(cohorts[0].retained).toBe(1);
    expect(cohorts[0].retentionRate).toBeCloseTo(1 / 3);
  });

  it("returns cohorts oldest-first and keeps only the last N", () => {
    const cohorts = buildSignupCohorts(
      [
        { createdAt: "2026-01-05T00:00:00.000Z", lastLoginAt: null },
        { createdAt: "2026-03-02T00:00:00.000Z", lastLoginAt: null },
      ],
      now,
      { maxCohorts: 1 }
    );
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].key).toBe("2026-03-02");
  });

  it("skips rows with an unparseable date rather than throwing", () => {
    const cohorts = buildSignupCohorts(
      [{ createdAt: "not-a-date", lastLoginAt: null }],
      now
    );
    expect(cohorts).toEqual([]);
  });
});
