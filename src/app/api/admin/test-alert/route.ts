// =============================================================================
// GENHUB - Prove the alarm reaches a human
// POST /api/admin/test-alert (ADMIN)
//
// `reportCredentialFault` has alerted on real faults — a rejected gateway key, a
// refused SMTP password — but whether ALERT_WEBHOOK_URL actually DELIVERS was
// only ever learned by waiting for an outage and then going to look at the
// logs. An alarm channel nobody has tested is a hope, not a channel.
//
// This sends one, on purpose, from the panel. It resets the per-service cooldown
// first so a test made shortly after a real alert still sends, and reports what
// happened back to the operator:
//   sent       delivered to the webhook (HTTP 2xx)
//   no-webhook ALERT_WEBHOOK_URL is not set — the alert only reached the log
//   failed     the webhook answered non-2xx or could not be reached
//
// The fault is labelled "[TEST]" so nobody reading the channel mistakes it for a
// real incident.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  reportCredentialFault,
  resetCredentialAlerts,
  type AlertOutcome,
} from "@/lib/credential-alert";

const OUTCOME_MESSAGE: Record<AlertOutcome, string> = {
  sent: "Test alert delivered to ALERT_WEBHOOK_URL.",
  "no-webhook":
    "No ALERT_WEBHOOK_URL is set, so the alert only went to the server log. Set it to receive alarms.",
  failed:
    "The alert webhook was reached but refused the message (non-2xx or unreachable). Check ALERT_WEBHOOK_URL.",
  cooldown: "An alert for this service was sent moments ago, so this one was suppressed.",
};

export async function POST() {
  try {
    await requireRole("ADMIN");

    // A test must actually attempt delivery, not be swallowed by the cooldown of
    // a real alert that fired minutes ago.
    resetCredentialAlerts();

    const outcome = await reportCredentialFault({
      service: "[TEST] Genhub admin",
      detail:
        "This is a test from the admin panel. No service is broken — use it to confirm this channel reaches you.",
    });

    return api.success({ outcome }, OUTCOME_MESSAGE[outcome]);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Test Alert Error]", error);
    return api.internal();
  }
}
