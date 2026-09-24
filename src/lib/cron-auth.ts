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
import config from "./config";
// Shared with the HarakaPay webhook, which needed the same property (problem 2
// below) and did not have it. One implementation, so neither can drift.
import { secretMatches } from "./shared-secret";

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
/**
 * The only origin value a request may claim, and what it is recorded as.
 *
 * A header that carried free text would let anything at all be written into the
 * heartbeat row and onto the admin card — and a caller who already holds
 * CRON_SECRET has no need of that extra power.
 */
const WATCHDOG_ORIGIN_HEADER = "watchdog";
const WATCHDOG_ORIGIN_LABEL = "restarted by the uptime watchdog";

/**
 * Who asked for this run, for the heartbeat.
 *
 * A scheduled trigger sends nothing and is recorded as scheduled, which is what
 * it is. The uptime watchdog restarts a worker whose schedule has died (see
 * PRODUCTION.md §4.0.2) and declares itself in `x-cron-origin`, so the run it
 * rescued is not filed as though the schedule had worked: an operator reading
 * "last run 04:45" on a card whose schedule is :00 needs to know which of the two
 * happened, because only one of them means the schedule is fixed.
 *
 * Only this one literal is accepted; anything else reads as undefined.
 */
export function cronOrigin(request: NextRequest): string | undefined {
  const declared = (request.headers.get("x-cron-origin") || "").trim().toLowerCase();
  return declared === WATCHDOG_ORIGIN_HEADER ? WATCHDOG_ORIGIN_LABEL : undefined;
}

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
