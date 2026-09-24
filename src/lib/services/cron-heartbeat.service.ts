// =============================================================================
// GENHUB - Background job heartbeats
//
// A schedule that stops firing is invisible. No request arrives, so there is no
// log line, no error and no metric — the app looks exactly like an app with
// nothing to do. That is how the HarakaPay webhook and the Bunny upload both
// stayed broken while every endpoint answered "success".
//
// So each worker stamps this table on every run, and "silence" becomes a
// readable fact: nothing finished recently. The registry below is the other
// half — a heartbeat is meaningless without the cadence it is supposed to keep,
// and having the cadence in code is what lets a missed run be computed rather
// than guessed at.
//
// Two rules that keep this honest:
//
//   * Every scheduled worker must be listed. A worker that writes no heartbeat
//     reads as "never ran", which is the safe direction — a false alarm, not a
//     false all-clear. `src/tests/cron-heartbeat.test.ts` scans the cron routes
//     so a new one cannot be added silently.
//   * Heartbeat writes never throw. A table that cannot be written must not
//     take down a worker that moves money; it degrades to a warning, and the
//     resulting staleness is itself visible.
//
// The registry also owns the run lock (runLockedAt). Supporting two schedulers
// at once — Vercel Cron and GitHub Actions — plus a manual "Run now" button in
// the admin panel means the same worker can be reached twice at the same
// instant, and for renew-subscriptions that is a second USSD charge on a real
// person's phone. One conditional UPDATE turns the second caller into a skip.
// =============================================================================

import prisma from "@/lib/db";
// The label a run is filed under when the uptime watchdog started it. Shared with
// the recovery notice rather than written twice: the notice decides whether a
// worker came back on its own or only because somebody restarted it, and two
// copies of that string is exactly how the two answers drift apart.
import { WATCHDOG_ORIGIN_LABEL } from "@/lib/cron-auth";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type CronWorkerId =
  | "release-earnings"
  | "reconcile-payments"
  | "renew-subscriptions"
  | "poll-encoding";

export interface CronWorkerDef {
  id: CronWorkerId;
  /** Human label for the admin card. */
  name: string;
  /** What stops happening while this worker does not run. */
  consequence: string;
  /** How often the scheduler is expected to call it (minutes). */
  everyMinutes: number;
  /**
   * How long without a finished run before it counts as overdue (minutes).
   *
   * Deliberately several intervals, not one: a single late or skipped
   * invocation is normal for both Vercel Cron and GitHub Actions (whose
   * schedules are delayed under load), and an alarm that cries wolf gets
   * ignored. This is set to roughly 4 missed runs.
   */
  staleAfterMinutes: number;
  /**
   * How long a single run may stay unfinished before it is presumed dead
   * (minutes).
   *
   * Separate from staleAfterMinutes on purpose, and much tighter. These jobs
   * finish in seconds (measured: 0.4-2.5s, and the slowest sends USSD pushes),
   * so a run still open after minutes is not slow — it was killed, most likely
   * by a function timeout. Reusing the stale budget here would report a run
   * that has been dead for forty minutes as "running", which is the one answer
   * that stops anyone looking.
   */
  inFlightGraceMinutes: number;
  /** Where the schedule is declared, so the card can point at the fix. */
  schedule: string;
  /**
   * True when running this worker reaches a customer's phone.
   *
   * Only renew-subscriptions does: it falls back to a HarakaPay USSD push, so a
   * stray run sends a real charge request to a real fan. The admin "Run now"
   * action therefore requires an explicit confirmation for it and not for the
   * others, where a run only moves internal state.
   */
  sendsCustomerRequests: boolean;
}

export const CRON_WORKERS: readonly CronWorkerDef[] = [
  {
    id: "release-earnings",
    name: "Release matured earnings",
    consequence:
      "Creator earnings stay inside the 14-day holding period and creators cannot withdraw.",
    everyMinutes: 60,
    staleAfterMinutes: 180,
    inFlightGraceMinutes: 10,
    schedule: "vercel.json or .github/workflows/release-earnings.yml",
    sendsCustomerRequests: false,
  },
  {
    id: "reconcile-payments",
    name: "Reconcile stale payments",
    consequence:
      "A charge the gateway accepted but never reported is never settled, and nobody is told.",
    everyMinutes: 10,
    staleAfterMinutes: 40,
    inFlightGraceMinutes: 5,
    schedule: "vercel.json or .github/workflows/reconcile-payments.yml",
    // Reads gateway state about charges that already exist; it never starts one.
    sendsCustomerRequests: false,
  },
  {
    id: "renew-subscriptions",
    name: "Renew subscriptions",
    consequence: "Memberships expire instead of renewing, and the fan is never retried.",
    everyMinutes: 60,
    staleAfterMinutes: 180,
    // Longest of the four: it sends one USSD push per subscriber, and each push
    // is a round trip to the gateway.
    inFlightGraceMinutes: 15,
    schedule: "vercel.json or .github/workflows/renew-subscriptions.yml",
    // The only worker that can charge someone who did not ask, right now: when
    // the wallet cannot cover a renewal it sends a USSD prompt to the fan.
    sendsCustomerRequests: true,
  },
  {
    id: "poll-encoding",
    name: "Publish finished uploads",
    consequence:
      "A transcoded video is never published, so the creator waits for a video that is already ready.",
    // vercel.json asks for 3 minutes; GitHub Actions cannot go below 5.
    everyMinutes: 5,
    staleAfterMinutes: 20,
    inFlightGraceMinutes: 5,
    schedule: "vercel.json or .github/workflows/poll-encoding.yml",
    sendsCustomerRequests: false,
  },
] as const;

const WORKERS_BY_ID = new Map<string, CronWorkerDef>(CRON_WORKERS.map((w) => [w.id, w]));

/** Every route that must report a heartbeat. */
export const SCHEDULED_CRON_ROUTE_IDS: readonly CronWorkerId[] = CRON_WORKERS.map((w) => w.id);

function workerDef(id: CronWorkerId): CronWorkerDef {
  const def = WORKERS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown cron worker "${id}" — add it to CRON_WORKERS`);
  return def;
}

/**
 * Look a worker up by an untrusted id (an admin request, say).
 *
 * Returns undefined rather than throwing so the caller decides what a bad id
 * means — for an API route that is a 422 naming the valid ids, not a crash.
 */
export function findWorker(id: string): CronWorkerDef | undefined {
  return WORKERS_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const MAX_DETAIL_CHARS = 500;

function describe(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return message.slice(0, MAX_DETAIL_CHARS);
}

/**
 * Best-effort heartbeat write.
 *
 * Never throws: see the file header. The warning is intentionally loud enough to
 * find in logs, because a heartbeat that cannot be written means the stale
 * alarm is blind.
 */
async function writeHeartbeat(
  id: CronWorkerId,
  data: {
    startedAt: Date;
    outcome: "OK" | "ERROR";
    summary?: string | null;
    error?: string | null;
    /** Who started this run; null (or absent) for a scheduled one. */
    origin?: string | null;
  }
): Promise<void> {
  const durationMs = Date.now() - data.startedAt.getTime();
  const base = {
    lastStartedAt: data.startedAt,
    lastFinishedAt: new Date(),
    lastOutcome: data.outcome,
    lastSummary: data.summary ?? null,
    lastError: data.error ?? null,
    lastDurationMs: durationMs,
    lastOrigin: data.origin ?? null,
  };

  try {
    await prisma.cronHeartbeat.upsert({
      where: { worker: id },
      create: {
        worker: id,
        ...base,
        consecutiveFailures: data.outcome === "ERROR" ? 1 : 0,
        runsTotal: 1,
      },
      update: {
        ...base,
        // Reset on success so the count always means "failing right now".
        consecutiveFailures: data.outcome === "ERROR" ? { increment: 1 } : 0,
        runsTotal: { increment: 1 },
      },
    });
  } catch (error) {
    console.warn(`[CronHeartbeat] Could not record "${id}": ${describe(error)}`);
  }
}

/** Best-effort start stamp, for the fail-open path where no claim was taken. */
async function stampStart(worker: CronWorkerId, startedAt: Date): Promise<void> {
  try {
    await prisma.cronHeartbeat.upsert({
      where: { worker },
      create: { worker, lastStartedAt: startedAt },
      update: { lastStartedAt: startedAt },
    });
  } catch (error) {
    console.warn(`[CronHeartbeat] Could not mark start of "${worker}": ${describe(error)}`);
  }
}

// ---------------------------------------------------------------------------
// The run lock
// ---------------------------------------------------------------------------

/**
 * Take the lock for one worker, atomically.
 *
 * A single conditional UPDATE decides the winner: the row is claimable only when
 * the lock is free, so two callers arriving in the same millisecond cannot both
 * read "free" and both proceed — which is the whole reason this is a statement
 * and not a read-then-write. Claiming also stamps the start, because the two
 * facts are the same instant and a killed run must stay distinguishable from
 * one that never began.
 *
 * `staleBefore` is the worker's own in-flight grace: a run that died without
 * releasing the lock expires rather than blocking the worker forever.
 */
export async function claimRun(
  worker: CronWorkerId,
  startedAt: Date,
  staleBefore: Date
): Promise<{ claimed: true } | { claimed: false; lockedAt: Date | null }> {
  const taken = await prisma.cronHeartbeat.updateMany({
    where: {
      worker,
      OR: [{ runLockedAt: null }, { runLockedAt: { lt: staleBefore } }],
    },
    data: { runLockedAt: startedAt, lastStartedAt: startedAt },
  });

  if (taken.count === 1) return { claimed: true };

  // Nothing was claimable. Either the lock is genuinely held, or this worker has
  // never run and so has no row to update yet.
  const existing = await prisma.cronHeartbeat.findUnique({
    where: { worker },
    select: { runLockedAt: true },
  });

  if (existing) return { claimed: false, lockedAt: existing.runLockedAt };

  try {
    await prisma.cronHeartbeat.create({
      data: { worker, runLockedAt: startedAt, lastStartedAt: startedAt },
    });
    return { claimed: true };
  } catch {
    // Lost a race against another first-ever run: treat it as held, like any
    // other concurrent claim.
    const raced = await prisma.cronHeartbeat.findUnique({
      where: { worker },
      select: { runLockedAt: true },
    });
    return { claimed: false, lockedAt: raced?.runLockedAt ?? null };
  }
}

/**
 * Release the lock, but only if it is still ours.
 *
 * The `runLockedAt: startedAt` condition matters: if our run outlived its own
 * grace and a newer run claimed the row, an unconditional release would hand
 * that run's lock to a third caller.
 */
async function releaseRun(worker: CronWorkerId, startedAt: Date): Promise<void> {
  try {
    await prisma.cronHeartbeat.updateMany({
      where: { worker, runLockedAt: startedAt },
      data: { runLockedAt: null },
    });
  } catch (error) {
    console.warn(`[CronHeartbeat] Could not release the run lock for "${worker}": ${describe(error)}`);
  }
}

/**
 * What a trigger got back: the job's result, or a refusal because the job was
 * already running.
 *
 * A refusal is not a failure, and callers must not report it as one — a
 * scheduler that gets a 500 for a skipped duplicate would page someone about a
 * job that is working correctly.
 */
export type CronRunOutcome<T> =
  | { ran: true; result: T; summary: string | null; durationMs: number }
  | { ran: false; reason: string; lockedAt: Date | null };

/**
 * Run a cron job, holding its lock, and record how it went.
 *
 * The lock is what makes an extra trigger harmless. Two schedulers can be
 * configured at once (Vercel Cron and GitHub Actions are both supported), and a
 * run can also be started by hand from the admin panel; without this, renewals
 * could push a second USSD charge to the same fan.
 *
 * A run that is refused still reports `ran: false` rather than throwing, so the
 * caller chooses how loud to be. Errors from the job itself are recorded and
 * then re-thrown, so the route still answers 500 and the scheduler still sees a
 * failure.
 */
export async function runCronJob<T>(
  worker: CronWorkerId,
  run: () => Promise<T>,
  summarize?: (result: T) => string,
  origin?: string
): Promise<CronRunOutcome<T>> {
  const def = workerDef(worker);
  const startedAt = new Date();
  const staleBefore = new Date(startedAt.getTime() - def.inFlightGraceMinutes * 60_000);

  let claim: { claimed: true } | { claimed: false; lockedAt: Date | null };
  try {
    claim = await claimRun(worker, startedAt, staleBefore);
  } catch (error) {
    // Fail open, on purpose. Every one of these jobs reads the same database the
    // lock lives in, so a lock query that fails means the job has nothing to
    // work on anyway — and refusing to run on an unrelated read failure would
    // stop money from moving, which is the worse of the two failures.
    console.warn(
      `[CronHeartbeat] Could not claim the run lock for "${worker}": ${describe(error)}. ` +
        "Running anyway — overlapping runs are not protected while this lasts."
    );
    claim = { claimed: true };
    await stampStart(worker, startedAt);
  }

  if (!claim.claimed) {
    const heldFor = claim.lockedAt ? humanDuration(minutesSince(claim.lockedAt, startedAt) ?? 0) : null;
    return {
      ran: false,
      lockedAt: claim.lockedAt,
      reason:
        `A run started ${heldFor ?? "recently"} ago and has not finished, so this one was ` +
        `skipped rather than run twice. It is not stuck: if it died, the lock expires ` +
        `${def.inFlightGraceMinutes} min after it started.`,
    };
  }

  try {
    const result = await run();
    const summary = summarize ? summarize(result) : null;
    await writeHeartbeat(worker, {
      startedAt,
      outcome: "OK",
      // Both forms, on purpose: the column is what code tests (the recovery
      // notice reads it), and the suffix is what a person reads on the card.
      origin: origin ?? null,
      summary: origin ? (summary ? `${summary} (${origin})` : origin) : summary,
    });
    return {
      ran: true,
      result,
      summary,
      durationMs: Date.now() - startedAt.getTime(),
    };
  } catch (error) {
    await writeHeartbeat(worker, {
      startedAt,
      outcome: "ERROR",
      origin: origin ?? null,
      error: origin ? `${describe(error)} (${origin})` : describe(error),
    });
    throw error;
  } finally {
    await releaseRun(worker, startedAt);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CronWorkerState = "never" | "late" | "stalled" | "failing" | "running" | "ok";

/** States that need someone to act. `running` and `ok` do not, and `never` is
 *  unconfigured setup rather than a regression — see CronHealth.degraded. */
const ALERTING_STATES: readonly CronWorkerState[] = ["late", "stalled", "failing"];

export interface CronWorkerHealth {
  id: CronWorkerId;
  name: string;
  consequence: string;
  schedule: string;
  everyMinutes: number;
  staleAfterMinutes: number;
  inFlightGraceMinutes: number;
  /** Reaches a customer's phone (a USSD charge request), so a manual run asks first. */
  sendsCustomerRequests: boolean;
  state: CronWorkerState;
  /** Minutes since the last *finished* run; null when it has never finished. */
  ageMinutes: number | null;
  /**
   * The moment this worker was last known to be alive — the run it finished, or
   * the run it started and never came back from. null only when it has never
   * run. This is the "since when" an operator asks for, as a timestamp rather
   * than an age, because an age cannot be checked against a deploy or a log.
   */
  silentSince: string | null;
  /**
   * Minutes since `silentSince`.
   *
   * Not the same as `ageMinutes`: for a run killed mid-job, `ageMinutes` counts
   * from the last run that *finished* — possibly days earlier, and possibly
   * never — while the silence actually began when the dead run started.
   */
  silentForMinutes: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSummary: string | null;
  /** Who started the last run; null when it was the schedule. */
  lastOrigin: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  runsTotal: number;
  /** A run began and never finished — a timeout or a crash mid-job. */
  unfinishedRun: boolean;
  /** One line an operator can act on. */
  detail: string;
}

export interface CronHealth {
  workers: CronWorkerHealth[];
  /**
   * The ids of the workers that need someone, most urgent first.
   *
   * Sent as an order rather than left for the reader to compute: "two of four
   * need attention" tells an operator that something is wrong and nothing else,
   * and the question they opened the page with is which one. `never` is not
   * here — no scheduler yet is setup work, and the card says so separately,
   * with the fix.
   */
  needsAttention: CronWorkerId[];
  /** `needsAttention` as one line, naming each worker and how long it has been
   *  silent. Empty when nothing needs attention. */
  attentionSummary: string;
  counts: Record<CronWorkerState, number>;
  /** Workers needing attention right now: overdue, stalled, or failing. */
  alerting: number;
  /**
   * True when something that used to run has stopped or is failing. A worker
   * that has *never* run does not set this — that is an unconfigured schedule
   * (setup), not a regression, and treating it as an outage would make a fresh
   * deploy permanently degraded and train operators to ignore the alarm.
   */
  degraded: boolean;
  checkedAt: string;
}

function minutesSince(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
}

/**
 * A plain duration — no "ago". The sentences below add their own preposition,
 * and a helper that hard-codes one produces "for 3 h ago" and "30 min ago ago".
 */
function humanDuration(minutes: number): string {
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** The classification rule, pure and testable — see the tests for the table. */
/**
 * Order of precedence, most specific first:
 *
 *   1. no heartbeat      -> never     (nothing is configured to call it)
 *   2. run never came back -> stalled (killed mid-job)
 *   3. run in progress    -> running (working, not idle)
 *   4. nothing finished in the budget -> late (the schedule stopped)
 *   5. last run errored   -> failing
 *   6. otherwise          -> ok
 */
export function classifyWorker(
  def: CronWorkerDef,
  beat: {
    lastStartedAt: Date | null;
    lastFinishedAt: Date | null;
    lastOutcome: string | null;
    lastError: string | null;
  } | null,
  now: Date = new Date()
): {
  state: CronWorkerState;
  detail: string;
  unfinishedRun: boolean;
  ageMinutes: number | null;
  silentSince: Date | null;
} {
  if (!beat) {
    return {
      state: "never",
      unfinishedRun: false,
      ageMinutes: null,
      silentSince: null,
      detail: `Has never run. Nothing is calling it — check ${def.schedule}.`,
    };
  }

  const started = beat.lastStartedAt;
  const finished = beat.lastFinishedAt;
  const ageMinutes = minutesSince(finished, now);
  // The last sign of life. Everything except a killed run is measured from the
  // run that finished; a killed run is measured from the start it never
  // returned from, because that is when the worker actually went quiet.
  const aliveAt = finished ?? started;

  // A run is in flight when a start is newer than the last finish.
  const unfinishedRun = !!started && (!finished || started.getTime() > finished.getTime());
  const startedAge = minutesSince(started, now);
  const stalled = unfinishedRun && startedAge !== null && startedAge > def.inFlightGraceMinutes;

  // A run that began and never came back. Reported on its own because it needs
  // a different fix from a dead schedule: the scheduler is fine, the job is
  // dying when it runs — a function timeout, or an error before its own handler
  // could catch it. Checked first: this is the most specific thing we know.
  if (stalled) {
    return {
      state: "stalled",
      unfinishedRun,
      ageMinutes,
      silentSince: started,
      detail:
        `A run started ${humanDuration(startedAge ?? 0)} ago and never finished — it was ` +
        `killed mid-job (function timeout or crash). It runs every ${def.everyMinutes} min, ` +
        `so later attempts are failing the same way.`,
    };
  }

  // In flight and still inside its budget: working, not idle. Checked before
  // the overdue test so a legitimately slow run is not reported as missing.
  if (unfinishedRun) {
    return {
      state: "running",
      unfinishedRun,
      ageMinutes,
      silentSince: aliveAt,
      detail: `Running now (started ${humanDuration(startedAge ?? 0)} ago).`,
    };
  }

  // Nothing has finished inside the budget: the schedule has stopped firing.
  const referenceAge = minutesSince(finished ?? started, now);
  if (referenceAge === null || referenceAge > def.staleAfterMinutes) {
    return {
      state: "late",
      unfinishedRun,
      ageMinutes,
      silentSince: aliveAt,
      detail:
        `Nothing has finished for ${humanDuration(referenceAge ?? 0)} (expected every ` +
        `${def.everyMinutes} min). The schedule has stopped firing — check ${def.schedule}.`,
    };
  }

  if (beat.lastOutcome === "ERROR") {
    return {
      state: "failing",
      unfinishedRun,
      ageMinutes,
      silentSince: aliveAt,
      detail: `Last run failed ${humanDuration(ageMinutes ?? 0)} ago: ${beat.lastError ?? "unknown error"}`,
    };
  }

  return {
    state: "ok",
    unfinishedRun,
    ageMinutes,
    silentSince: aliveAt,
    detail: `Last run succeeded ${humanDuration(ageMinutes ?? 0)} ago.`,
  };
}

/**
 * Severity for the admin card, in the order an operator would fix them.
 *
 * A killed run outranks a stopped schedule: both are silent, but this one is
 * failing *while it tries*, so the scheduler is working and something inside
 * the job is not — and a job that is merely `failing` has been reporting itself
 * all along. `running`, `ok` and `never` are ranked too so the comparison is
 * total, but they never reach the list.
 */
const ATTENTION_RANK: Record<CronWorkerState, number> = {
  stalled: 0,
  late: 1,
  failing: 2,
  running: 3,
  ok: 4,
  never: 5,
};

/**
 * The workers that need someone, most urgent first; longest silence first
 * within a state.
 *
 * Pure, so the ordering is tested rather than eyeballed in a card.
 */
export function workersNeedingAttention(
  workers: readonly CronWorkerHealth[]
): CronWorkerHealth[] {
  return workers
    .filter((w) => ALERTING_STATES.includes(w.state))
    .slice()
    .sort(
      (a, b) =>
        ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state] ||
        (b.silentForMinutes ?? 0) - (a.silentForMinutes ?? 0)
    );
}

/**
 * The stopped workers as one line, each named with how long it has been quiet.
 *
 * This is the sentence the card leads with. A count of affected workers is a
 * status; naming them and dating the silence is the answer to the question
 * somebody opened the dashboard with — and it is the difference between a page
 * that reports a problem and one that reports it usefully.
 */
export function attentionSummary(workers: readonly CronWorkerHealth[]): string {
  return workersNeedingAttention(workers)
    .map((w) => {
      const quietFor = humanDuration(w.silentForMinutes ?? w.ageMinutes ?? 0);
      if (w.state === "stalled") return `${w.name}: a run started ${quietFor} ago and never finished`;
      if (w.state === "failing") return `${w.name}: last failure ${quietFor} ago`;
      return `${w.name}: nothing finished for ${quietFor}`;
    })
    .join(" · ");
}

/** Read every worker's health. Workers with no heartbeat report as "never". */
export async function getCronHealth(now: Date = new Date()): Promise<CronHealth> {
  const rows = await prisma.cronHeartbeat.findMany();
  const byWorker = new Map(rows.map((r) => [r.worker, r]));

  const workers: CronWorkerHealth[] = CRON_WORKERS.map((def) => {
    const row = byWorker.get(def.id) ?? null;
    const verdict = classifyWorker(def, row, now);

    return {
      id: def.id,
      name: def.name,
      consequence: def.consequence,
      schedule: def.schedule,
      everyMinutes: def.everyMinutes,
      staleAfterMinutes: def.staleAfterMinutes,
      inFlightGraceMinutes: def.inFlightGraceMinutes,
      sendsCustomerRequests: def.sendsCustomerRequests,
      state: verdict.state,
      ageMinutes: verdict.ageMinutes,
      silentSince: verdict.silentSince?.toISOString() ?? null,
      silentForMinutes: minutesSince(verdict.silentSince, now),
      unfinishedRun: verdict.unfinishedRun,
      lastStartedAt: row?.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: row?.lastFinishedAt?.toISOString() ?? null,
      lastSummary: row?.lastSummary ?? null,
      lastOrigin: row?.lastOrigin ?? null,
      lastError: row?.lastError ?? null,
      lastDurationMs: row?.lastDurationMs ?? null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      runsTotal: row?.runsTotal ?? 0,
      detail: verdict.detail,
    };
  });

  const counts: Record<CronWorkerState, number> = {
    never: 0,
    late: 0,
    stalled: 0,
    failing: 0,
    running: 0,
    ok: 0,
  };
  for (const w of workers) counts[w.state] += 1;

  const alerting = ALERTING_STATES.reduce((sum, state) => sum + counts[state], 0);
  const needing = workersNeedingAttention(workers);

  return {
    workers,
    needsAttention: needing.map((w) => w.id),
    attentionSummary: attentionSummary(needing),
    counts,
    alerting,
    // "never" is excluded on purpose — see the CronHealth doc comment.
    degraded: alerting > 0,
    checkedAt: now.toISOString(),
  };
}

/**
 * The one-word verdict for /api/health, without leaking which worker or why.
 *
 * Ordered by severity, and "never" is reported rather than folded into "ok":
 * a scheduled worker that has never once run is a real gap even if the others
 * are healthy, and an uptime monitor is the only reader that is awake when
 * nobody is looking at the dashboard.
 */
export function summarizeCronHealth(
  health: CronHealth
): "late" | "stalled" | "failing" | "never" | "ok" {
  for (const state of ALERTING_STATES) {
    if (health.counts[state] > 0) return state as "late" | "stalled" | "failing";
  }
  if (health.counts.never > 0) return "never";
  return "ok";
}

// ---------------------------------------------------------------------------
// The watchdog's memory: telling a recovery apart from a quiet day
//
// "Is that worker fine now?" cannot be answered from a heartbeat. A heartbeat
// describes the present, so a worker that came back an hour ago looks exactly
// like one that was never broken — which is why an operator keeps chasing a
// schedule somebody already fixed, and why a restart that worked is never
// confirmed to the person who started it. The memory is one row per worker the
// watchdog has reported: open while it is down, closed when it is healthy again.
//
// Closing it is not the same as deleting it. The row keeps when it was first
// reported and when it came back, so the record survives a webhook that never
// arrived — the notice is a nudge, the app is the record.
// ---------------------------------------------------------------------------

export interface CronRecovery {
  id: string;
  name: string;
  /** The state the watchdog last reported while it was down. */
  wasState: string;
  /** When it was *first* reported — how long it was stuck. */
  alertedAt: string;
  alertedForMinutes: number;
  /** Where it is now: `ok`, or `running` when a run is already in flight. */
  state: CronWorkerState;
  lastSummary: string | null;
  /**
   * True when the run that brought it back was one the uptime watchdog started.
   *
   * This is the distinction the whole notice exists for: the worker is running
   * again either because the schedule came back (fixed — close the ticket) or
   * because the only reason there is a run at all is that the watchdog started
   * one (still broken — and it will need starting again next hour).
   */
  restartedByWatchdog: boolean;
}

export interface CronWatchSync {
  recovered: CronRecovery[];
  /** `recovered` as one sentence. Empty when there is nothing to report. */
  summary: string;
}

/**
 * The recovery notice, in words.
 *
 * Pure, so both readings are pinned by tests rather than discovered in a chat
 * message at 3am. The two sentences must never read the same: one of them means
 * "this is over" and the other means "this will happen again in an hour".
 */
export function recoverySummary(recoveries: readonly CronRecovery[]): string {
  return recoveries
    .map((r) => {
      const quietFor = humanDuration(r.alertedForMinutes);
      if (r.restartedByWatchdog) {
        return (
          `${r.name} is running again after ${quietFor}, but the run that brought it back ` +
          "was one the uptime watchdog started — the schedule is still not firing (§4.0.1)"
        );
      }
      return `${r.name} is running again after ${quietFor} — the schedule is firing again`;
    })
    .join(" · ");
}

/**
 * Record what this run of the watchdog sees, and report what came back.
 *
 * Called by the watchdog on *every* run, healthy or not: the moment to notice a
 * recovery is the run where nothing else is wrong, which is also the run that
 * would otherwise finish in silence.
 *
 * A worker is only reported as recovered when it is genuinely back — `ok` or
 * `running`. A `never` (its rows were cleared, or a scheduler was removed) keeps
 * the mark open, because claiming a recovery nobody can see would be the worst
 * of both worlds: the operator stops looking and the worker is still down.
 */
export async function syncCronWatch(now: Date = new Date()): Promise<CronWatchSync> {
  const health = await getCronHealth(now);
  const marks = await prisma.cronWatch.findMany();
  const markByWorker = new Map(marks.map((m) => [m.worker, m]));

  const recovered: CronRecovery[] = [];

  for (const worker of health.workers) {
    const mark = markByWorker.get(worker.id);

    if (ALERTING_STATES.includes(worker.state)) {
      if (mark) {
        // Still down. Keep the original date (how long it has been stuck is the
        // useful number — and re-dating it here would reset the outage to "0 min"
        // on every run) and refresh the state, so the notice describes the
        // problem as it was last seen rather than as it was first guessed.
        if (mark.resolvedAt || mark.alertedState !== worker.state) {
          await prisma.cronWatch.update({
            where: { worker: worker.id },
            data: { alertedState: worker.state, resolvedAt: null },
          });
        }
      } else {
        // Dated the way the alarm dates it, not the way this run found it.
        //
        // The alarm says "nothing finished for 4 h", measured from the worker's
        // own silence. Dating the recovery from the moment the watchdog happened
        // to look would answer "running again after 0 min" an hour after that
        // alarm was sent — two sentences about one outage that nobody can line
        // up. A worker is also usually found already past its budget, so the
        // sighting is late by construction: it is the silence that is the length
        // of the outage, and it is already on the payload.
        const beganAt = worker.silentSince ? new Date(worker.silentSince) : now;
        await prisma.cronWatch.create({
          data: { worker: worker.id, alertedAt: beganAt, alertedState: worker.state },
        });
      }
      continue;
    }

    if (!mark || mark.resolvedAt) continue;
    if (worker.state !== "ok" && worker.state !== "running") continue;

    recovered.push({
      id: worker.id,
      name: worker.name,
      wasState: mark.alertedState,
      alertedAt: mark.alertedAt.toISOString(),
      alertedForMinutes: minutesSince(mark.alertedAt, now) ?? 0,
      state: worker.state,
      lastSummary: worker.lastSummary,
      restartedByWatchdog: worker.lastOrigin === WATCHDOG_ORIGIN_LABEL,
    });

    await prisma.cronWatch.update({
      where: { worker: worker.id },
      data: { resolvedAt: now },
    });
  }

  return { recovered, summary: recoverySummary(recovered) };
}
