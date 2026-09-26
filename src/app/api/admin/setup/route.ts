// =============================================================================
// GENHUB - Launch Setup API Route
// GET   /api/admin/setup  - assess the checklist against the live config
// POST  /api/admin/setup  - the same, plus real connection probes
// PATCH /api/admin/setup  - tick a manual step off (or put it back)
//
// Both are ADMIN only. The GET response is deliberately built to be safe to
// render in a browser: secret values are reported as "set · N characters" and
// never echoed (see summariseValue in src/lib/setup-check.ts).
//
// Probes are split into their own verb so they talk to Postgres, Redis, Bunny,
// your SMTP relay and HarakaPay - a page load should not do that.
//
// -----------------------------------------------------------------------------
// WHY PATCH EXISTS: THE BADGE THAT COULD NOT BE CLEARED
//
// Some steps have no environment variable to check - fund the gateway float,
// allow the domain as a Bunny referrer. They used to be counted as "todo"
// unconditionally, from the moment the checklist was written, so the Setup tab
// carried a permanent badge of 3: opening it, reading every line and doing every
// step left the number exactly where it was. An operator learns to ignore a
// counter that never moves, and it sits next to the ones that do mean something.
//
// A manual step is now recorded as done, by whom and when, and the badge counts
// only what is genuinely outstanding.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { assessSetup, runLiveProbes, SETUP_ITEMS } from "@/lib/setup-check";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

// Prisma, ioredis, nodemailer and node:fs all need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The manual steps (no env var) an admin has already ticked off. */
async function doneManualSteps(): Promise<Set<string>> {
  const rows = await prisma.setupStep.findMany({ select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

export async function GET() {
  try {
    await requireRole("ADMIN");
    return api.success(assessSetup(await doneManualSteps()));
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Setup Error]", error);
    return api.internal();
  }
}

export async function POST(_request: NextRequest) {
  try {
    await requireRole("ADMIN");

    // Probes run in parallel inside runLiveProbes, but a whole sweep still takes
    // as long as the slowest service. The report is returned together with them
    // so the page re-renders the checklist at the same moment.
    const done = await doneManualSteps();
    const [report, probes] = await Promise.all([assessSetup(done), runLiveProbes()]);

    return api.success({ ...report, probes });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Setup Probe Error]", error);
    return api.internal();
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json().catch(() => ({}));
    const stepId = typeof body?.stepId === "string" ? body.stepId : "";
    const done = body?.done !== false; // ticking on unless explicitly undone

    // Only a real manual step may be recorded. Without this check the endpoint
    // would happily store any id at all, and the checklist would accumulate
    // rows that correspond to nothing.
    const step = SETUP_ITEMS.find((item) => item.id === stepId && !item.key);
    if (!step) return api.validation("That step is not part of the checklist");

    if (done) {
      await prisma.setupStep.upsert({
        where: { id: stepId },
        create: { id: stepId, title: step.title, doneBy: auth.userId },
        // Re-ticking keeps the original date: when it was actually done is the
        // fact worth keeping, and a second click is not a second completion.
        update: {},
      });
    } else {
      await prisma.setupStep.deleteMany({ where: { id: stepId } });
    }

    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.setupStep,
      targetType: "SetupStep",
      targetId: stepId,
      summary: `${done ? "Marked done" : "Reopened"} the manual launch step "${step.title}"`,
      detail: { done },
    });

    return api.success(
      assessSetup(await doneManualSteps()),
      done ? "Step marked done" : "Step reopened"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Setup Step Error]", error);
    return api.internal();
  }
}
