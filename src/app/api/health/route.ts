// =============================================================================
// GENHUB - Health Check API
// GET /api/health - Lightweight status endpoint for uptime monitors and
// post-deploy verification. Reports database reachability and any production
// configuration warnings (never secret values).
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import config, { productionConfigWarnings } from "@/lib/config";

const startedAt = Date.now();

export async function GET(_request: NextRequest) {
  let database: "up" | "down" = "down";
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "up";
  } catch {
    database = "down";
  }

  const warnings = productionConfigWarnings();
  const healthy = database === "up";

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      nodeEnv: config.nodeEnv,
      checks: {
        database,
        email: config.email.host ? "smtp" : "console",
        sms: config.sms.apiKey ? "africastalking" : "console",
        // "sandbox" = no USSD push and no real money moves (dev default)
        payments: config.harakaPay.sandbox ? "sandbox" : "live",
        bunny: config.bunny.apiKey ? "configured" : "missing",
      },
      warnings,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
