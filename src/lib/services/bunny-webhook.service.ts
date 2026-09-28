// =============================================================================
// GENHUB - Bunny Stream webhook: recording deliveries, and proving the setup
//
// Two jobs, both about the same blind spot. The upload pipeline has a self-test
// that uploads a real file, because "the key is valid" is not "uploads work"
// (see runBunnyPipelineSelfTest). The webhook had no equivalent: an operator set
// BUNNY_STREAM_WEBHOOK_SECRET, pasted a URL into the Bunny library, and had no
// way to find out whether any of it worked except by uploading a video and
// waiting.
//
//   1. recordBunnyWebhookDelivery — every verified callback is stamped into
//      Redis, so "has Bunny ever reached us?" becomes a fact with a timestamp
//      instead of a guess. It is the ONLY evidence available for the half of the
//      setup that lives in Bunny's dashboard: their library API returns counts
//      and nothing else (measured — `GET /library/{id}` answers
//      `{videoCount, liveStreamCount, collectionCount}`), so the configured
//      Webhook URL cannot be read back, compared or validated from here.
//      A recorded delivery IS that configuration working.
//
//   2. runBunnyWebhookSelfTest — posts one correctly signed callback to this
//      deployment's own endpoint and one forged callback, and reports what came
//      back. That covers everything on our side: the secret is present, the
//      route shipped in this build, the host is not blocking it, the signature
//      rule accepts genuine callbacks and refuses forgeries, and a finished
//      event maps to the publishing intent.
//
// Neither is part of the Setup tab's Re-check sweep: the self-test makes two
// real HTTP requests to the public URL, so it is a button somebody presses, the
// same as the upload probe next door.
//
// SECURITY: the callback used by the self-test names
// BUNNY_WEBHOOK_TEST_GUID — an id no video can have — so a `Status 3`
// (Finished) event can exercise the publish path without publishing anything.
// =============================================================================

import config from "@/lib/config";
import {
  inspectBunnyWebhookSecret,
  signBunnyWebhookTest,
  type BunnyWebhookSecretReport,
} from "@/lib/bunny-webhook";
import { cacheGet, cacheSet } from "@/lib/redis";

// -----------------------------------------------------------------------------
// Recording what arrives
// -----------------------------------------------------------------------------

const DELIVERY_KEY = "bunny:webhook:last";

/**
 * Long enough that a delivery is still on record the next time somebody looks —
 * an upload and its callbacks are minutes apart, but the operator asking "did
 * this ever work?" may be days later. One key, so this cannot grow.
 */
const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface BunnyWebhookDelivery {
  /** When the callback arrived, ISO. */
  at: string;
  /** Bunny's event code and its label, when the body carried one. */
  status: number | null;
  label: string | null;
  /** What we decided to do about it. */
  intent: string;
  matched: boolean;
  published: boolean;
  videoId: string | null;
}

/**
 * Best-effort record of a verified callback.
 *
 * Never throws and never blocks the response beyond the caller's own await: the
 * cache layer already degrades to a skipped write when Redis is unavailable
 * (lib/redis.ts), and a callback that published a video must not be turned into
 * an error by a bookkeeping write.
 */
export async function recordBunnyWebhookDelivery(
  delivery: Omit<BunnyWebhookDelivery, "at">
): Promise<void> {
  await cacheSet(DELIVERY_KEY, { ...delivery, at: new Date().toISOString() }, DELIVERY_TTL_SECONDS);
}

/** The last recorded callback, or null when there is none to read. */
export async function lastBunnyWebhookDelivery(): Promise<BunnyWebhookDelivery | null> {
  const value = await cacheGet<BunnyWebhookDelivery>(DELIVERY_KEY);
  if (!value || typeof value !== "object" || typeof value.at !== "string") return null;
  return value;
}

// -----------------------------------------------------------------------------
// Proving the setup
// -----------------------------------------------------------------------------

export interface WebhookSelfTestStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BunnyWebhookSelfTest {
  verdict: "ok" | "not-configured" | "failed";
  headline: string;
  detail: string;
  /** The URL that was tested, so the operator can compare it with Bunny's. */
  target: string;
  secret: BunnyWebhookSecretReport;
  steps: WebhookSelfTestStep[];
}

/** Where this deployment's own callbacks land. */
export function bunnyWebhookUrl(appUrl: string = config.appUrl): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/bunny`;
}

interface SelfPost {
  status: number;
  /** Parsed body, or null when it was not JSON. */
  body: Record<string, unknown> | null;
  error: string | null;
}

/** POST a signed body to our own endpoint. Never throws: the answer is data. */
async function postToSelf(
  target: string,
  rawBody: string,
  headers: Record<string, string>
): Promise<SelfPost> {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body, error: null };
  } catch (error) {
    return {
      status: 0,
      body: null,
      error: String((error as Error)?.message || error).slice(0, 160),
    };
  }
}

/**
 * Drive the whole receiving half against the live deployment.
 *
 * Order matters: the static checks come first, so a missing secret is reported
 * as the setup step it is rather than as two failed HTTP requests. Only when a
 * secret exists is anything posted, and the forged request deliberately reuses
 * the genuine body with one byte added — the signature is checked before the
 * body is parsed, so it must be refused without ever being read.
 */
export async function runBunnyWebhookSelfTest(): Promise<BunnyWebhookSelfTest> {
  const target = bunnyWebhookUrl();
  const secret = config.bunny.webhookSecret;
  const report = inspectBunnyWebhookSecret({
    secret,
    mainKey: config.bunny.apiKey,
    // Judged as the deployed site will judge it: a development deployment
    // accepts unsigned callbacks, so a local run would report healthy no matter
    // what the secret is.
    nodeEnv: "production",
  });

  const steps: WebhookSelfTestStep[] = [
    {
      label: "Signing secret",
      ok: report.configured && !report.matchesMainKey,
      detail: !report.configured
        ? "BUNNY_STREAM_WEBHOOK_SECRET is not set — production refuses every callback with a 401, so finished uploads wait for a dashboard visit or the worker sweep"
        : report.matchesMainKey
          ? `${secret.length} characters, but this is the library's MAIN API key. Callbacks are signed with the library's READ-ONLY key — copy that one into BUNNY_STREAM_WEBHOOK_SECRET`
          : `set (${secret.length} characters), and it is not the main API key`,
    },
    {
      label: "Verification rule",
      ok: report.acceptsGenuine && report.refusesForged,
      detail:
        report.acceptsGenuine && report.refusesForged
          ? "a body signed with this secret is accepted, and the same body signed with anything else is refused"
          : "the signature rule did not behave as it must, so this build should not be trusted with callbacks",
    },
  ];

  if (!report.configured) {
    return {
      verdict: "not-configured",
      headline: "No webhook secret configured",
      detail:
        `Set BUNNY_STREAM_WEBHOOK_SECRET to the Stream library's Read-Only API key, then set the ` +
        `library's Webhook URL to ${target}. Until then a finished encode still publishes — on the ` +
        `next dashboard visit or worker sweep, not in seconds.`,
      target,
      secret: report,
      steps,
    };
  }

  const genuine = signBunnyWebhookTest(secret, config.bunny.libraryId);
  const accepted = await postToSelf(target, genuine.rawBody, genuine.headers);
  const acceptedOk = accepted.status === 200 && accepted.body?.status === "ok";
  steps.push({
    label: "Endpoint accepts a signed callback",
    ok: acceptedOk,
    detail: accepted.error
      ? `${target} could not be reached: ${accepted.error}`
      : acceptedOk
        ? `HTTP ${accepted.status}, accepted as a "${String(accepted.body?.intent ?? "?")}" event` +
          (accepted.body?.matched === false ? " (the test id owns no video, so nothing was published)" : "")
        : `HTTP ${accepted.status}${accepted.body?.error ? ` — ${String(accepted.body.error)}` : ""}`,
  });

  const tampered = await postToSelf(target, `${genuine.rawBody} `, {
    "Content-Type": "application/json",
    "X-BunnyStream-Signature": genuine.signature,
  });
  const refusedOk = tampered.status === 401;
  steps.push({
    label: "Endpoint refuses a forged callback",
    ok: refusedOk,
    detail: tampered.error
      ? `${target} could not be reached: ${tampered.error}`
      : refusedOk
        ? "HTTP 401 — a body that does not match its signature is refused before it is parsed"
        : `HTTP ${tampered.status} — a tampered body was NOT refused, which is a serious problem`,
  });

  if (acceptedOk && refusedOk) {
    return {
      verdict: "ok",
      headline: "This deployment accepts and verifies callbacks",
      detail:
        `A signed caller gets through and a forged one does not. The other half is Bunny's own ` +
        `setting, and its API cannot read it back, so check by eye that the Stream library's Webhook ` +
        `URL is exactly ${target}. Once it is, the next finished upload shows up in the "Bunny ` +
        `webhook" check on this tab within seconds of finishing.`,
      target,
      secret: report,
      steps,
    };
  }

  return {
    verdict: "failed",
    headline: "The endpoint did not behave as it must",
    detail:
      accepted.error || tampered.error
        ? `The test could not reach ${target}. If that URL is wrong, NEXT_PUBLIC_APP_URL is wrong too — ` +
          "and Bunny would be posting into nowhere."
        : "One of the two calls above returned the wrong answer; nothing about the signature rule or the " +
          "route changed, which usually means the deployed build predates them.",
    target,
    secret: report,
    steps,
  };
}
