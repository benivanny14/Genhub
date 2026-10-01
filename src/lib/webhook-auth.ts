// =============================================================================
// GENHUB - ClickPesa webhook authorization
//
// This sits beside cron-auth.ts rather than in src/lib/payments/, which holds
// the gateway *integration* and nothing else — enforced by
// src/tests/gateway-guard.test.ts. This file is an authorization decision, the
// same kind of thing as the cron rule next door.
//
// ClickPesa offers two ways to prove a callback is theirs, and this accepts
// either:
//
//   1. A `checksum` — an HMAC-SHA256 over the recursively key-sorted, compact
//      JSON body (excluding `checksum` and `checksumMethod`), hex-encoded and
//      keyed on the checksum key from the dashboard. This is the strong option
//      and the one ClickPesa recommends, because the secret never travels.
//   2. A shared token in the query string we give the dashboard for the webhook
//      URL (`?t=`). That is the one secret in this codebase that has to travel
//      in a URL — cron secrets are refused there (see lib/cron-auth.ts)
//      precisely because URLs end up in logs — but if checksum signing is off,
//      it is the only proof available.
//
// The rule, which mirrors requireCronSecret:
//
//   checksum key configured             -> require a valid checksum
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
  /** `config.clickPesa.webhookToken`, empty when the deployment has none. */
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
// ClickPesa payload checksum (HMAC-SHA256 over canonical JSON)
// =============================================================================

/** Recursively sort object keys so the serialization is order-independent. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * The checksum of a payload, exactly as ClickPesa computes it: canonicalize
 * (recursively sort keys), serialize compact, HMAC-SHA256 with the checksum key,
 * hex digest. Callers must exclude `checksum` / `checksumMethod` first.
 */
export function computePayloadChecksum(key: string, payload: unknown): string {
  const serialized = JSON.stringify(canonicalize(payload));
  return createHmac("sha256", key).update(serialized).digest("hex");
}

/**
 * Whether a ClickPesa callback carries a valid signature.
 *
 * The body must not include `checksum` / `checksumMethod` in the computation, so
 * they are stripped here. Comparison is timing-safe.
 */
export function verifyPayloadChecksum(options: {
  payload: Record<string, unknown>;
  provided: string;
  key: string;
}): boolean {
  const { payload, provided, key } = options;
  if (!provided || !key) return false;

  const { checksum: _checksum, checksumMethod: _method, ...rest } = payload;
  const expected = computePayloadChecksum(key, rest);

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The single decision the ClickPesa webhook route makes.
 *
 * Checksum wins when a key is configured (and a body without one is refused);
 * otherwise the shared URL token is checked; otherwise it fails closed in
 * production.
 */
export function verifyClickPesaWebhook(options: {
  payload: Record<string, unknown>;
  /** The `?t=` value the caller presented. */
  providedToken: string;
  checksumKey: string;
  webhookToken: string;
  nodeEnv: string;
}): WebhookTokenCheck {
  const { payload, providedToken, checksumKey, webhookToken, nodeEnv } = options;

  if (checksumKey) {
    const provided = typeof payload.checksum === "string" ? payload.checksum : "";
    return verifyPayloadChecksum({ payload, provided, key: checksumKey })
      ? { ok: true }
      : { ok: false, reason: provided ? "mismatch" : "not-configured" };
  }

  return verifyWebhookToken({
    provided: providedToken,
    configured: webhookToken,
    nodeEnv,
  });
}
