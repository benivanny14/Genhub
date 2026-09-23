// =============================================================================
// GENHUB - HarakaPay webhook authorization
//
// This sits beside cron-auth.ts rather than in src/lib/payments/, which holds
// the gateway *integration* and nothing else — enforced by
// src/tests/gateway-guard.test.ts. This file is an authorization decision, the
// same kind of thing as the cron rule next door.
//
// HarakaPay's spec has no HMAC signature, so the only thing that can prove a
// callback came from them is a shared token in the URL we hand them as
// webhook_url (`?t=`). That is the one secret in this codebase that has to
// travel in a query string — cron secrets are refused there (see
// lib/cron-auth.ts) precisely because URLs end up in logs. Here there is no
// alternative; the gateway offers nothing else.
//
// The rule, which mirrors requireCronSecret:
//
//   token configured + matches      -> proceed
//   token configured + does not     -> 401
//   no token, production             -> 401  (fail closed)
//   no token, anywhere else          -> proceed, so local work needs no token
//
// That last-but-one line is the change worth explaining. The check used to be
// `if (configuredToken && token !== configuredToken)`, so with no token
// configured the whole comparison was skipped and ANYONE could POST a completed
// callback for an order id they had created themselves — free access to paid
// content and a credit to the creator for money nobody paid.
//
// Failing closed costs nothing, because the webhook is an optimisation rather
// than the settlement path: /api/payments/status/<orderId> asks the gateway
// directly, and /api/cron/reconcile-payments sweeps every checkout still PENDING.
// A refused callback therefore delays a settlement by at most one sweep; it does
// not lose one.
//
// Keeping this out of the route is deliberate: the decision table is the kind of
// thing that is easy to get subtly wrong, and inside a request handler it can
// only be tested through the network.
// =============================================================================

import { secretMatches } from "./shared-secret";

export type WebhookTokenCheck =
  | { ok: true }
  | { ok: false; reason: "mismatch" | "not-configured" };

/**
 * Decide whether a webhook callback may be trusted.
 *
 * Pure — the environment is a parameter, so every branch is testable without a
 * running server or a particular NODE_ENV.
 */
export function verifyWebhookToken(options: {
  /** The `?t=` value the caller presented. */
  provided: string;
  /** `config.harakaPay.webhookToken`, empty when the deployment has none. */
  configured: string;
  /** `config.nodeEnv` — the same value the cron routes test. */
  nodeEnv: string;
}): WebhookTokenCheck {
  const { provided, configured, nodeEnv } = options;

  if (!configured) {
    if (nodeEnv === "production") return { ok: false, reason: "not-configured" };
    return { ok: true };
  }

  return secretMatches(provided, configured)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
