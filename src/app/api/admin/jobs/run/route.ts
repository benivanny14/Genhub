// =============================================================================
// GENHUB - Admin: run a background worker now
// POST /api/admin/jobs/run { worker, confirm? }
//
// Exists for the question the heartbeat card cannot answer on its own: "is this
// pipeline actually working, or does it just have nothing to do?" A worker
// showing `Never run` — or one that has been silent since a deploy — can be
// started here and the result read immediately, instead of waiting an hour for
// a schedule.
//
// It runs the *same* job through the same lock and heartbeat as the schedule
// (lib/services/cron-jobs.service.ts), so what an operator proves here is what
// the scheduler will do.
//
// Two refusals, both deliberate:
//
//   * ALREADY_RUNNING (409). The run lock is held, so this trigger is refused
//     rather than run concurrently. For renewals that difference is a second
//     USSD charge on a real fan's phone.
//   * CONFIRMATION_REQUIRED (409). Only renew-subscriptions can reach a
//     customer's phone, so a manual run of it must say so explicitly. Enforced
//     here rather than in the UI, because a guard that lives only in the button
//     is a guard a stray request walks past.
//
// Being a real run, it makes real changes — that is the point. Which is also
// why every run started here is recorded with its origin, so the heartbeat
// never reads as though a schedule did something a person did.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { CRON_WORKERS, findWorker, getCronHealth } from "@/lib/services/cron-heartbeat.service";
import { runWorkerNow } from "@/lib/services/cron-jobs.service";

// Longest of the four sends one USSD push per due subscriber, and each push is
// a round trip to the gateway. Same budget as the self-test route.
export const maxDuration = 60;

const bodySchema = z.object({
  worker: z.string().min(1),
  /** Required (and only meaningful) for workers that reach a customer's phone. */
  confirm: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return api.validation("Expected a JSON body like { \"worker\": \"poll-encoding\" }.");
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return api.validation("Expected a JSON body like { \"worker\": \"poll-encoding\" }.");
    }

    const def = findWorker(parsed.data.worker);
    if (!def) {
      return api.validation(
        `Unknown worker "${parsed.data.worker}". Registered workers: ` +
          `${CRON_WORKERS.map((w) => w.id).join(", ")}.`
      );
    }

    if (def.sendsCustomerRequests && parsed.data.confirm !== true) {
      return api.error(
        `${def.name} can send a charge request to a customer's phone, so it must be ` +
          `confirmed: send it again with "confirm": true.`,
        409,
        "CONFIRMATION_REQUIRED"
      );
    }

    let outcome;
    try {
      outcome = await runWorkerNow(def.id, { origin: "manual run from the admin panel" });
    } catch (error) {
      // The job died. Its heartbeat already says ERROR, so the card will show
      // that too — but the operator who clicked deserves the actual reason.
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[Admin Run Job] ${def.id} failed:`, error);
      return api.error(`${def.name} failed: ${message}`, 500, "JOB_FAILED");
    }

    if (!outcome.ran) {
      // Not an error: another trigger owns this worker right now.
      return api.error(outcome.reason, 409, "ALREADY_RUNNING");
    }

    // Fresh health in the same round trip, so the row the operator just ran
    // updates from this response instead of from a second request.
    const health = await getCronHealth();

    return api.success(
      {
        worker: def.id,
        summary: outcome.summary,
        durationMs: outcome.durationMs,
        result: outcome.result,
        health,
      },
      outcome.summary ?? `${def.name} ran.`
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Admin Run Job Error]", error);
    return api.internal();
  }
}
