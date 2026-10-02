// =============================================================================
// GENHUB - Signup cohorts and retention
//
// The one number a growth question needs is "of the people who joined in week
// W, how many are still around N days later?" A raw user count answers none of
// that: 10,000 signups that all left after a day is a different business from
// 1,000 who stayed. This groups accounts by the week they joined and counts how
// many have been active inside the retention window.
//
// "Active" is read from `lastLoginAt`, which is the only activity signal the
// schema keeps cheaply for everyone. That is a deliberate, coarse choice: it
// never counts a person who only sat on a signed-in tab, and it is enough to
// see a cohort that collapsed. Everything here is pure — the route fetches rows
// and hands them over — so the maths is testable without a database.
// =============================================================================

export interface CohortMember {
  /** ISO timestamp of when the account was created. */
  createdAt: string;
  /** ISO timestamp of the last sign-in, or null for an account that never did. */
  lastLoginAt: string | null;
}

export interface SignupCohort {
  /** Stable key: the Monday that starts the cohort's week (YYYY-MM-DD). */
  key: string;
  /** Short human label for that week. */
  label: string;
  size: number;
  /** Members seen inside the retention window. */
  retained: number;
  /** retained / size, 0..1. Zero for an empty cohort. */
  retentionRate: number;
}

/** The Monday at 00:00 UTC of the week containing `date`. */
export function weekStart(date: Date): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // getUTCDay: 0=Sunday. Shift so Monday is 0, then step back.
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Group members by signup week and measure retention.
 *
 * `now` is passed in rather than read from the clock so the result is
 * reproducible in a test. Cohorts are returned oldest-first, which is the order
 * a retention chart is read.
 */
export function buildSignupCohorts(
  members: CohortMember[],
  now: Date,
  options: { retentionDays?: number; maxCohorts?: number } = {}
): SignupCohort[] {
  const retentionDays = options.retentionDays ?? 30;
  const maxCohorts = options.maxCohorts ?? 12;
  const retentionFloor = now.getTime() - retentionDays * 86_400_000;

  const byWeek = new Map<string, { size: number; retained: number; start: Date }>();

  for (const member of members) {
    const created = new Date(member.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    const start = weekStart(created);
    const key = isoDay(start);
    const bucket = byWeek.get(key) ?? { size: 0, retained: 0, start };
    bucket.size += 1;

    // A member counts as retained when they signed in inside the window. An
    // account whose lastLoginAt is later than the window floor is active; one
    // with no login at all is not.
    if (member.lastLoginAt) {
      const seen = new Date(member.lastLoginAt).getTime();
      if (Number.isFinite(seen) && seen >= retentionFloor) bucket.retained += 1;
    }

    byWeek.set(key, bucket);
  }

  return Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-maxCohorts)
    .map(([key, bucket]) => ({
      key,
      label: bucket.start.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      }),
      size: bucket.size,
      retained: bucket.retained,
      retentionRate: bucket.size === 0 ? 0 : bucket.retained / bucket.size,
    }));
}
