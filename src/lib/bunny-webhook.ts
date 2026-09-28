// =============================================================================
// GENHUB - Bunny Stream webhook verification + event interpretation
//
// Bunny Stream posts a tiny callback to a URL configured on the video library
// every time a video changes state — upload started, encoding progressed,
// encoding finished, encoding failed. The body is only:
//
//   { "VideoLibraryId": 133, "VideoGuid": "<guid>", "Status": 3 }
//
// There is no title, no duration, no progress: enough to know WHICH video moved
// and roughly how far, not enough to publish it. Publishing therefore stays in
// video-encoding.service.ts, which reads the real details back from the API —
// this module only decides whether the callback is genuine and what it means.
//
// SECURITY: Bunny signs every Stream callback with HMAC-SHA256 over the EXACT
// raw request body, keyed on the library's Read-Only API key, and sends the
// digest as lowercase hex in `X-BunnyStream-Signature`. The body must be verified
// before it is parsed — re-serialising the JSON changes whitespace and key order
// and the signature stops matching — which is why the route reads `request.text()`
// and hands the raw string here.
//
// This file lives beside webhook-auth.ts rather than in lib/payments/: it is an
// authorization decision, the same kind of thing as the HarakaPay token rule
// next door, and the gateway guard forbids anything but the integration in
// lib/payments/.
// =============================================================================

import { createHmac } from "node:crypto";
import { secretMatches } from "./shared-secret";

/** Bunny's own status codes for a Stream webhook — NOT the GET-video codes. */
export const BUNNY_WEBHOOK_STATUS_LABELS: Record<number, string> = {
  0: "Queued",
  1: "Processing",
  2: "Encoding",
  3: "Finished",
  4: "Resolution finished",
  5: "Failed",
  6: "Upload started",
  7: "Upload finished",
  8: "Upload failed",
  9: "Captions generated",
  10: "Title/description generated",
};

/**
 * What a callback asks us to do.
 *
 *   ready    — encoding finished (Status 3); publish + notify.
 *   playable — one resolution is available (Status 4). Not fully finished, but
 *              the first such event means the video can already play, so it is
 *              worth re-reading the details.
 *   failed   — encoding or a presigned upload failed (Status 5 / 8).
 *   progress — queued/processing/encoding/upload/captions; refresh quietly.
 *   ignore   — a callback for a library that is not ours.
 */
export type BunnyWebhookIntent = "ready" | "playable" | "failed" | "progress" | "ignore";

export interface BunnyWebhookPayload {
  VideoLibraryId?: number | string;
  VideoGuid?: string;
  /** Older/alternate spelling of VideoGuid; tolerated when present. */
  VideoId?: string;
  Status?: number | string;
  /** Some callback variants carry a string event name; tolerated if present. */
  Event?: string;
  Type?: string;
}

export type BunnySignatureCheck =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "bad-headers" | "mismatch" };

/** UTF-8 HMAC-SHA256 of the raw body, lowercase hex — exactly what Bunny sends. */
export function computeBunnySignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Decide whether a Stream callback may be trusted.
 *
 * The decision table mirrors requireCronSecret / verifyWebhookToken:
 *
 *   secret configured + matches    -> proceed
 *   secret configured + mismatch   -> 401
 *   no secret, production          -> 401  (fail closed: an unsigned callback
 *                                            could publish or fail any video)
 *   no secret, anywhere else       -> proceed, so local work needs no secret
 *
 * The version/algorithm headers are checked only when they are PRESENT. Bunny's
 * own docs list them, but an independent write-up measured a delivery that did
 * not carry them, so requiring them would refuse a valid callback — while still
 * trusting the HMAC, which is the part that actually proves authenticity.
 */
export function verifyBunnySignature(options: {
  rawBody: string;
  /** `X-BunnyStream-Signature`, lowercase hex. */
  signature: string;
  /** `X-BunnyStream-Signature-Version`, e.g. "v1" — optional. */
  version?: string | null;
  /** `X-BunnyStream-Signature-Algorithm`, e.g. "hmac-sha256" — optional. */
  algorithm?: string | null;
  /** `config.bunny.webhookSecret`, empty when the deployment has none. */
  secret: string;
  /** `config.nodeEnv` — the same value the cron routes test. */
  nodeEnv: string;
}): BunnySignatureCheck {
  const { rawBody, signature, version, algorithm, secret, nodeEnv } = options;

  if (!secret) {
    if (nodeEnv === "production") return { ok: false, reason: "not-configured" };
    return { ok: true };
  }

  if (version && version !== "v1") return { ok: false, reason: "bad-headers" };
  if (algorithm && algorithm !== "hmac-sha256") return { ok: false, reason: "bad-headers" };

  return secretMatches(signature, computeBunnySignature(rawBody, secret))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/** Parse the callback body. Returns null when it is not JSON or not an object. */
export function parseBunnyWebhook(rawBody: string): BunnyWebhookPayload | null {
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as BunnyWebhookPayload;
  } catch {
    return null;
  }
}

/**
 * The video guid from a callback, or null.
 *
 * Bunny sends `VideoGuid`; older/alternate spellings send `VideoId`. Both are
 * accepted and the value is trimmed, so a stray space cannot make a real event
 * look unmatched.
 */
export function bunnyWebhookVideoId(payload: BunnyWebhookPayload): string | null {
  const raw = payload.VideoGuid ?? payload.VideoId;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value || null;
}

/** The library id from a callback as a string, or null. */
export function bunnyWebhookLibraryId(payload: BunnyWebhookPayload): string | null {
  const raw = payload.VideoLibraryId;
  if (raw === undefined || raw === null) return null;
  return String(raw);
}

/**
 * Map a callback to what we should do about it.
 *
 * `libraryId` is the deployment's own Stream library id: a callback for a
 * different library is ignored rather than acted on, so a secret shared across
 * several libraries cannot move another library's videos.
 */
/**
 * The status from a callback, with its label, or nulls when it carries none.
 *
 * Kept here rather than in the route because the admin panel reports the same
 * pair ("12 min ago · Status 3 — Finished") and two copies of that reading would
 * eventually disagree about what Bunny sent.
 */
export function describeBunnyWebhookStatus(payload: BunnyWebhookPayload): {
  status: number | null;
  label: string | null;
} {
  const status = Number(payload.Status);
  if (!Number.isFinite(status)) return { status: null, label: null };
  return { status, label: BUNNY_WEBHOOK_STATUS_LABELS[status] ?? null };
}

/**
 * A guid no real video can have.
 *
 * The endpoint test below posts a genuine `Status 3` callback — the one that
 * publishes — so the id it names must match nothing, or the test would publish
 * somebody's scene. All zeroes is a valid GUID shape that Bunny never issues.
 */
export const BUNNY_WEBHOOK_TEST_GUID = "00000000-0000-0000-0000-000000000000";

export interface SignedBunnyWebhookTest {
  /** The exact bytes that must be signed and posted; never re-serialised. */
  rawBody: string;
  signature: string;
  headers: Record<string, string>;
}

/**
 * Build and sign the callback this deployment posts to ITSELF.
 *
 * A configured secret proves nothing on its own: the value can be wrong, the
 * route can be missing from the build, and the host can be refusing the path.
 * Posting one signed callback through the real route answers all three at once,
 * which is the difference between "it is set" and "it works".
 *
 * It is a `Status 3` (Finished) event for {@link BUNNY_WEBHOOK_TEST_GUID}, so it
 * exercises the publishing intent while being incapable of publishing anything.
 */
export function signBunnyWebhookTest(
  secret: string,
  libraryId: string | null | undefined
): SignedBunnyWebhookTest {
  const numeric = Number(libraryId);
  const rawBody = JSON.stringify({
    VideoLibraryId: libraryId && Number.isFinite(numeric) ? numeric : 0,
    VideoGuid: BUNNY_WEBHOOK_TEST_GUID,
    Status: 3,
  });
  const signature = computeBunnySignature(rawBody, secret);

  return {
    rawBody,
    signature,
    headers: {
      "Content-Type": "application/json",
      "X-BunnyStream-Signature": signature,
      "X-BunnyStream-Signature-Version": "v1",
      "X-BunnyStream-Signature-Algorithm": "hmac-sha256",
    },
  };
}

export interface BunnyWebhookSecretReport {
  configured: boolean;
  /** A body signed with this secret is accepted, judged as production would. */
  acceptsGenuine: boolean;
  /** The same body signed with anything else is refused. */
  refusesForged: boolean;
  /**
   * The secret IS the library's read-write management key.
   *
   * This is the mistake the panel exists to catch: Bunny signs Stream callbacks
   * with the library's READ-ONLY key, and pasting the main key looks configured
   * while every real callback is refused. The value can never be read back from
   * Bunny (its library endpoint returns only counts — measured), so an equality
   * check against the key we already hold is the only warning available.
   */
  matchesMainKey: boolean;
}

/**
 * What the configured secret can and cannot prove, without any network work.
 *
 * Deliberately judged with `nodeEnv: "production"`: this is the rule the
 * deployed site will apply, and a development deployment accepts unsigned
 * callbacks, which would make every report read healthy.
 */
export function inspectBunnyWebhookSecret(options: {
  secret: string;
  /** `config.bunny.apiKey` — the read-write key, for the equality warning. */
  mainKey?: string;
  nodeEnv?: string;
}): BunnyWebhookSecretReport {
  const { secret, mainKey = "", nodeEnv = "production" } = options;

  if (!secret) {
    return {
      configured: false,
      acceptsGenuine: false,
      refusesForged: false,
      matchesMainKey: false,
    };
  }

  const sample = JSON.stringify({
    VideoLibraryId: 0,
    VideoGuid: BUNNY_WEBHOOK_TEST_GUID,
    Status: 3,
  });

  const genuine = verifyBunnySignature({
    rawBody: sample,
    signature: computeBunnySignature(sample, secret),
    secret,
    nodeEnv,
  });
  const forged = verifyBunnySignature({
    rawBody: sample,
    signature: computeBunnySignature(sample, `${secret}-not-the-secret`),
    secret,
    nodeEnv,
  });

  return {
    configured: true,
    acceptsGenuine: genuine.ok,
    refusesForged: !forged.ok,
    matchesMainKey: !!mainKey && mainKey === secret,
  };
}

export function bunnyWebhookIntent(
  payload: BunnyWebhookPayload,
  libraryId?: string | null
): BunnyWebhookIntent {
  const library = bunnyWebhookLibraryId(payload);
  if (libraryId && library && library !== String(libraryId)) return "ignore";

  // String event names first: they are unambiguous where present.
  const event = (payload.Event ?? payload.Type ?? "").toLowerCase();
  if (event) {
    if (/ready|encoded|finished|complete/.test(event)) return "ready";
    if (/fail|error/.test(event)) return "failed";
    // A recognised but non-terminal name still merits a quiet refresh.
    if (event) return "progress";
  }

  const status = Number(payload.Status);
  if (!Number.isFinite(status)) return "progress";

  switch (status) {
    case 3:
      return "ready";
    case 4:
      // One resolution is done and the first of these means it can play; the
      // details read-back decides whether it is genuinely finished.
      return "playable";
    case 5:
    case 8:
      return "failed";
    default:
      return "progress";
  }
}
