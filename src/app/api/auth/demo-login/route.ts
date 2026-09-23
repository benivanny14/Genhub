// =============================================================================
// GENHUB - Demo Login API Route (DEVELOPMENT ONLY)
// POST /api/auth/demo-login - Signs in as a seeded demo account.
// Disabled in production.
//
// The guard below reads process.env.NODE_ENV directly rather than
// config.nodeEnv, which DEFAULTS to "development" when unset — a self-hosted
// deployment that forgets NODE_ENV=production would otherwise expose an
// endpoint that mints an ADMIN session. Rate limited as well, so the failure
// mode is bounded rather than open.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { generateToken, setAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";

const ACCOUNTS = {
  creator: "demo-creator-1",
  viewer: "demo-viewer-1",
  admin: "demo-admin-1",
} as const;

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return api.error("Demo login is disabled in production", 403, "FORBIDDEN");
  }

  try {
    const { allowed } = await checkRateLimit(
      `demo-login:${clientIp(request.headers)}`,
      config.rateLimit.auth.max,
      config.rateLimit.auth.windowMs
    );
    if (!allowed) return api.rateLimited("Too many attempts — please wait a moment");

    const body = await request.json().catch(() => ({}));
    const account = body?.account as keyof typeof ACCOUNTS;
    if (!account || !(account in ACCOUNTS)) {
      return api.validation("account must be 'creator' or 'viewer'");
    }

    const user = await prisma.user.findUnique({
      where: { id: ACCOUNTS[account] },
      select: { id: true, email: true, role: true, isBanned: true },
    });

    if (!user) {
      return api.notFound("Demo accounts missing — run POST /api/demo/seed first");
    }
    if (user.isBanned) return api.forbidden("Demo account is banned");

    const token = await generateToken({
      userId: user.id,
      email: user.email || undefined,
      role: user.role,
    });
    await setAuthCookie(token);

    return api.success({ id: user.id, role: user.role }, "Signed in with demo account");
  } catch (error) {
    console.error("[Demo Login Error]", error);
    return api.internal();
  }
}
