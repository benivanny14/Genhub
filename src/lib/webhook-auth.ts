// =============================================================================
// GENHUB - SonicPesa webhook authorization
//
// This sits beside cron-auth.ts rather than in src/lib/payments/, which holds
// the gateway *integration* and nothing else — enforced by
// src/tests/gateway-guard.test.ts. This file is an authorization decision, the
// same kind of thing as the cron rule next door.
//
// SonicPesa offers two ways to prove a callback is theirs, and this accepts
// either:
//
//   1. A signature header, `X-SonicPesa-Signature` — an HMAC-SHA256 over the RAW
//      request body, hex-encoded and keyed on the API secret. This is the strong
//      option and the one SonicPesa documents, because the secret never travels.
//      The RAW bytes matter: the signature is over exactly what was sent, so the
//      body has to be held and hashed BEFORE it is parsed.
//   2. A shared token in the query string we give the dashboard for the webhook
//      URL (`?t=`). That is the one secret in this codebase that has to travel
//      in a URL — cron secrets are refused there (see lib/cron-auth.ts)
//      precisely because URLs end up in logs — but if signature signing is off,
//      it is the only proof available.
//
// The rule, which mirrors requireCronSecret:
//
//   secret key configured              -> require a valid signature
//   token configured + matches          -> proceed
//   token configured + does not         -> 401
//   nothing configured, production      -> 401  (fail closed)
//   nothing configured, anywhere else   -> proceed, so local work needs no secret
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

import { createHmac, timingSafeEqual } from "node:crypto";
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
  /** `config.sonicPesa.webhookToken`, empty when the deployment has none. */
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

// =============================================================================
// SonicPesa payload signature (HMAC-SHA256 over the raw request body)
// =============================================================================

/**
 * The signature of a SonicPesa callback, exactly as they compute it:
 * HMAC-SHA256 over the RAW request body, hex digest, keyed on the API secret.
 */
export function computeSonicPesaSignature(secretKey: string, rawBody: string): string {
  return createHmac("sha256", secretKey).update(rawBody, "utf8").digest("hex");
}

/**
 * Whether a SonicPesa callback carries a valid signature.
 *
 * The comparison is timing-safe: a bare `===` on a signature leaks how much of
 * it was guessed right, one request at a time.
 */
export function verifySonicPesaSignature(options: {
  /** The exact bytes the gateway signed. */
  rawBody: string;
  /** The `X-SonicPesa-Signature` header the caller presented. */
  provided: string;
  secretKey: string;
}): boolean {
  const { rawBody, provided, secretKey } = options;
  if (!provided || !secretKey) return false;

  const expected = computeSonicPesaSignature(secretKey, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The single decision the SonicPesa webhook route makes.
 *
 * A configured secret key wins (and a callback without a valid signature is
 * refused); otherwise the shared URL token is checked; otherwise it fails
 * closed in production.
 */
export function verifySonicPesaWebhook(options: {
  /** The raw request body, before it was parsed. */
  rawBody: string;
  /** The `X-SonicPesa-Signature` header the caller presented. */
  providedSignature: string;
  /** The `?t=` value the caller presented. */
  providedToken: string;
  secretKey: string;
  webhookToken: string;
  nodeEnv: string;
}): WebhookTokenCheck {
  const { rawBody, providedSignature, providedToken, secretKey, webhookToken, nodeEnv } =
    options;

  if (secretKey) {
    return verifySonicPesaSignature({ rawBody, provided: providedSignature, secretKey })
      ? { ok: true }
      : { ok: false, reason: providedSignature ? "mismatch" : "not-configured" };
  }

  return verifyWebhookToken({
    provided: providedToken,
    configured: webhookToken,
    nodeEnv,
  });
}
