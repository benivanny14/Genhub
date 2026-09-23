// =============================================================================
// GENHUB - Cron: Release Matured Earnings
// GET/POST /api/cron/release-earnings
// Moves creator earnings out of the 14-day holding period into
// availableBalance. Schedule every hour (Vercel Cron, GitHub Actions, or any
// external scheduler) with header `x-cron-secret: $CRON_SECRET`.
// Auth: CRON_SECRET via `Authorization: Bearer` or `x-cron-secret` header
// only — a query-string secret would be written to access logs. Refuses to run
// unprotected in production. Rule lives in lib/cron-auth.ts.
// =============================================================================

import { NextRequest } from "next/server";
import { api } from "@/lib/api-response";
import { requireCronSecret } from "@/lib/cron-auth";
import { releaseMatureEarnings } from "@/lib/services/earning-release.service";

async function handle(request: NextRequest) {
  // One shared rule for every cron route: header-only secret, timing-safe
  // compare, fail closed in production. See lib/cron-auth.ts for why the
  // `?secret=` query form was removed.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  try {
    const result = await releaseMatureEarnings();
    return api.success(
      result,
      `Released TZS ${result.released.toLocaleString()} for ${result.creators} creator(s)`
    );
  } catch (error) {
    console.error("[Cron Release Earnings Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
