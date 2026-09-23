// =============================================================================
// GENHUB - Cron authorization (ONE implementation)
//
// Four cron routes each used to verify the secret themselves, and they had
// drifted into two different rule sets:
//
//   release-earnings, renew-subscriptions   bearer | x-cron-secret | ?secret=   config.cron.secret
//   reconcile-payments, process-holdings    bearer | x-cron-secret              process.env.CRON_SECRET
//
// Three problems with that:
//
// 1. `?secret=` puts a live secret in the URL. Query strings are written to
//    access logs, proxy logs and analytics, so the value ends up retained
//    somewhere other than the server's environment. This secret authorizes
//    MOVING MONEY — releasing creator earnings into a withdrawable balance and
//    charging subscribers — so anyone with log access could replay it. Neither
//    scheduler actually needs it: Vercel Cron sends `Authorization: Bearer`,
//    and the GitHub Actions workflow sends `x-cron-secret`.
//
// 2. `!==` on a secret is not constant-time. It leaks how many leading
//    characters were correct, which is how timing attacks narrow a guess.
//
// 3. Two rule sets means a fix in one file silently leaves the others wrong.
//    The rule now lives here, and every route calls it.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import config from "./config";

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the buffers are always the same length:
 * timingSafeEqual throws on unequal lengths, and that throw itself would leak
 * the secret's length.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The secret presented with the request, from headers only. */
function presentedSecret(request: NextRequest): string {
  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return (request.headers.get("x-cron-secret") || "").trim();
}

/**
 * Authorize a cron request.
 *
 * @returns `null` when the request may proceed, or the response to return.
 *
 * Usage:
 *   const denied = requireCronSecret(request);
 *   if (denied) return denied;
 */
export function requireCronSecret(request: NextRequest): NextResponse | null {
  const expected = config.cron.secret;

  if (!expected) {
    // Refuse to run an unauthenticated money-moving job in production just
    // because CRON_SECRET was never set. Outside production, allow it so local
    // work needs no scheduler configured.
    if (config.nodeEnv === "production") {
      return NextResponse.json(
        { success: false, error: "CRON_SECRET is not configured" },
        { status: 401 }
      );
    }
    return null;
  }

  // Deliberately NOT read from request.nextUrl.searchParams: a secret in a URL
  // is a secret in a log file. See the file header.
  if (request.nextUrl.searchParams.has("secret")) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Cron secret must be sent in the Authorization header or x-cron-secret — query strings are logged and are not accepted",
      },
      { status: 401 }
    );
  }

  const provided = presentedSecret(request);
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
