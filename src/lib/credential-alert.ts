// =============================================================================
// GENHUB - Say it the moment a credential stops working, not up to an hour later
//
// The hourly watchdog already raises the alarm when a configured service is
// broken, and that is the right net for a credential that rots while nobody is
// looking. What it is not is *prompt*: a gateway key revoked at 10:02 is
// reported somewhere between 10:02 and 11:00, and every collect in between is
// accepted by a gateway that will never deliver it.
//
// This is the other half. When the app itself discovers the fault — a key
// rejected, a mail password refused, the cache not answering — it says so once,
// immediately.
//
// Three rules it must not break:
//
//   * It never depends on Redis. A dead cache is one of the faults it reports,
//     so a dedupe kept there would go quiet exactly when it is needed most.
//   * It never throws and never blocks a request. Callers use `void`; a failure
//     to report a failure must not become a second failure.
//   * It says each thing once per window. An alarm that repeats on every failing
//     request is an alarm somebody mutes.
//
// The window is kept in process memory, so on a serverless host each instance
// dedupes on its own and one fault can alert from a few of them. That is the
// right way for an alarm to be wrong: a couple of duplicates beat one silence.
// =============================================================================

import config from "./config";

/** How long a service stays quiet after it has alerted once. */
const COOLDOWN_MS = 30 * 60_000;

/** A webhook that hangs must not become a request that hangs. */
const WEBHOOK_TIMEOUT_MS = 5_000;

const lastAlertedAt = new Map<string, number>();

export interface CredentialFault {
  /** Named the way the operator knows it: "HarakaPay", "SMTP". */
  service: string;
  /** What was observed, in the words the log already used. */
  detail: string;
}

export type AlertOutcome = "sent" | "cooldown" | "no-webhook" | "failed";

/**
 * Report a configured credential that has stopped working.
 *
 * Resolves with what happened rather than throwing, so a caller that wants to
 * test it can, and a caller that does not can write `void`.
 */
export async function reportCredentialFault(
  fault: CredentialFault,
  deps: { now?: () => number; fetchImpl?: typeof fetch; webhookUrl?: string } = {}
): Promise<AlertOutcome> {
  const now = deps.now ?? (() => Date.now());
  const service = fault.service;

  const previous = lastAlertedAt.get(service);
  if (previous !== undefined && now() - previous < COOLDOWN_MS) return "cooldown";

  // Claim the window before awaiting anything: two requests failing at the same
  // instant should alert once, not twice.
  lastAlertedAt.set(service, now());

  // Always logged, webhook or not. With no ALERT_WEBHOOK_URL configured this
  // line is the record — and the site must not depend on one being set.
  const line = `[Credential Alert] ${service} is configured but not working: ${fault.detail}`;
  console.error(line);

  const webhookUrl = deps.webhookUrl ?? (process.env.ALERT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) return "no-webhook";

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Slack reads `text`, Discord reads `content`. Sending both means one
      // message works in either without asking which one it is.
      body: JSON.stringify({
        text: `${line}\n(${config.appUrl})`,
        content: `${line}\n(${config.appUrl})`,
        service,
        detail: fault.detail,
        appUrl: config.appUrl,
        at: new Date(now()).toISOString(),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[Credential Alert] webhook answered HTTP ${response.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("[Credential Alert] webhook failed:", (error as Error)?.message || error);
    return "failed";
  }
}

/** For tests: forget every cooldown. */
export function resetCredentialAlerts(): void {
  lastAlertedAt.clear();
}

/**
 * Codes that mean "the credential is wrong", as opposed to "this one request was
 * wrong".
 *
 * The mail path needs the distinction: one bad recipient address must not be
 * reported as a revoked SMTP password. nodemailer puts a code on its errors, and
 * these are the ones an operator can act on.
 */
const CREDENTIAL_ERROR_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "EPROTO",
]);

export function isCredentialFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || "").toUpperCase();
  return CREDENTIAL_ERROR_CODES.has(code);
}
