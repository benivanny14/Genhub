// =============================================================================
// GENHUB - The cron jobs themselves
//
// One place that answers "what does this worker actually do, and what does its
// result read like". The scheduled routes and the admin panel's "Run now"
// button both come through here, so a manual run executes exactly what the
// schedule executes — not a copy that can drift from it.
//
// Two things left this file rather than being written twice:
//
//   * the wording. Each worker's summary is what the heartbeat row stores and
//     what the dashboard shows, so there used to be one copy in the cron route
//     and, if this had been done the obvious way, a second one in the admin
//     route. Now there is one.
//   * the mapping from worker id to function. It is a switch over the registry
//     type, so adding a worker without wiring it here fails the type check
//     instead of producing a worker the dashboard can display but nothing can
//     run.
//
// The lock, the heartbeat and the "already running" refusal belong to
// runCronJob in cron-heartbeat.service.ts — callers get all three by calling
// runWorkerNow, and cannot accidentally get only some of them.
// =============================================================================

import {
  runCronJob,
  type CronRunOutcome,
  type CronWorkerId,
} from "./cron-heartbeat.service";
import { releaseMatureEarnings, type ReleaseResult } from "./earning-release.service";
import { reconcileStalePayments, type ReconcileResult } from "./payment-reconcile.service";
import { renewDueSubscriptions, type RenewalResult } from "./subscription-renewal.service";
import { refreshPendingEncodings } from "./video-encoding.service";

/**
 * Inferred rather than imported: video-encoding.service.ts already exports a
 * different `RefreshResult` (one video's refresh), and taking the type from the
 * function is the only way to be sure these stay the same thing.
 */
type EncodingRunResult = Awaited<ReturnType<typeof refreshPendingEncodings>>;

// ---------------------------------------------------------------------------
// Wording
//
// These strings end up in the heartbeat row and on the admin dashboard, so they
// are part of the interface: they say what moved, not how the code works.
// ---------------------------------------------------------------------------

export function describeReleaseEarnings(result: ReleaseResult): string {
  return `Released TZS ${result.released.toLocaleString()} for ${result.creators} creator(s)`;
}

export function describeReconcile(result: ReconcileResult): string {
  return (
    `${result.checked} checked, ${result.settledSuccess} settled, ` +
    `${result.underInvestigation} newly flagged, ` +
    `${result.awaitingResolution} awaiting resolution, ` +
    `${result.stillProcessing} still processing`
  );
}

export function describeRenewals(result: RenewalResult): string {
  return (
    `Renewals: ${result.renewedFromWallet} from wallet, ${result.pushedToPhone} USSD push(es), ` +
    `${result.awaitingApproval} awaiting approval, ${result.failed} failed`
  );
}

export function describeEncoding(result: EncodingRunResult): string {
  return `${result.checked} checked, ${result.published} published, ${result.failed} failed`;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface WorkerRunOptions {
  /**
   * Appended to what the heartbeat records, e.g. "manual run from the admin
   * panel". The heartbeat is this app's only record of who moved money, so a
   * run a human started must not look identical to a scheduled one.
   */
  origin?: string;
}

/**
 * Run one worker, by id.
 *
 * Overloaded so each call site keeps the concrete result type of its own worker
 * — the reconcile route spreads its result into a response body, and it should
 * not have to cast to do that.
 *
 * `ran: false` means the job was already running and this trigger was refused.
 * It is not an error: a scheduler that treats it as one pages someone about a
 * job that is working.
 */
export function runWorkerNow(
  id: "release-earnings",
  options?: WorkerRunOptions
): Promise<CronRunOutcome<ReleaseResult>>;
export function runWorkerNow(
  id: "reconcile-payments",
  options?: WorkerRunOptions
): Promise<CronRunOutcome<ReconcileResult>>;
export function runWorkerNow(
  id: "renew-subscriptions",
  options?: WorkerRunOptions
): Promise<CronRunOutcome<RenewalResult>>;
export function runWorkerNow(
  id: "poll-encoding",
  options?: WorkerRunOptions
): Promise<CronRunOutcome<EncodingRunResult>>;
/**
 * A worker id that is only known at runtime — the admin panel takes it from a
 * request body. Callers here get `unknown`, which is the honest type: they have
 * not said which worker they are running.
 */
export function runWorkerNow(
  id: CronWorkerId,
  options?: WorkerRunOptions
): Promise<CronRunOutcome<unknown>>;
export async function runWorkerNow(
  id: CronWorkerId,
  options: WorkerRunOptions = {}
): Promise<CronRunOutcome<unknown>> {
  const origin = options.origin;

  switch (id) {
    // process-holdings reports as release-earnings: it is a legacy alias for
    // this same job, not a second worker, so a deployment whose old cron config
    // points there must not leave release-earnings looking like it never runs.
    // The id is passed as a literal rather than the narrowed variable, so the
    // worker each case touches is visible in the source — the heartbeat test
    // scans for exactly this.
    case "release-earnings":
      return runCronJob("release-earnings", () => releaseMatureEarnings(), describeReleaseEarnings, origin);

    case "reconcile-payments":
      return runCronJob("reconcile-payments", () => reconcileStalePayments(), describeReconcile, origin);

    case "renew-subscriptions":
      return runCronJob("renew-subscriptions", () => renewDueSubscriptions(), describeRenewals, origin);

    case "poll-encoding":
      return runCronJob("poll-encoding", () => refreshPendingEncodings(), describeEncoding, origin);
  }
}
