// =============================================================================
// GENHUB - Launch Setup API Route
// GET  /api/admin/setup  - assess the checklist against the live config
// POST /api/admin/setup  - the same, plus real connection probes
//
// Both are ADMIN only. The GET response is deliberately built to be safe to
// render in a browser: secret values are reported as "set · N characters" and
// never echoed (see summariseValue in src/lib/setup-check.ts).
//
// Probes are split into their own verb because they talk to Postgres, Redis,
// Bunny, your SMTP relay and HarakaPay - a page load should not do that.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { assessSetup, runLiveProbes } from "@/lib/setup-check";

// Prisma, ioredis, nodemailer and node:fs all need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("ADMIN");
    return api.success(assessSetup());
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
    const [report, probes] = await Promise.all([assessSetup(), runLiveProbes()]);

    return api.success({ ...report, probes });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Setup Probe Error]", error);
    return api.internal();
  }
}
