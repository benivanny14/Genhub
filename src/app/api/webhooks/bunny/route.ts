// =============================================================================
// GENHUB - Bunny Stream webhook handler
// POST /api/webhooks/bunny
//
// Bunny posts a tiny callback whenever a video changes state — most importantly
// `Status: 3` (Finished), which is the moment a scene becomes playable. This
// route is what turns that callback into a database write, so a finished encode
// goes playable within seconds.
//
// THIS IS THE SOURCE OF TRUTH for the transition to READY. A push is the only
// thing that can observe an encode finishing the moment it finishes, so
// everything else is a fallback: the scheduled sweep in
// /api/cron/video-encoding (which walks rows still carrying an encoding status),
// the creator's dashboard read, and the owner's page read — each for a
// deployment whose callbacks are misconfigured or whose callback was missed.
//
// A missed callback therefore degrades, rather than strands: the two on-read
// paths still refresh the row (with a re-check floor), and the client poller on
// an open page picks the new state up as soon as any of them writes it.
//
// SECURITY
//   * The body is signature-checked BEFORE it is parsed. Bunny signs the exact
//     raw bytes with HMAC-SHA256 (lib/bunny-webhook.ts); `request.text()` keeps
//     them intact, JSON.parse does not.
//   * A callback naming another library is ignored outright.
//   * The handler never trusts the payload beyond the guid: it re-reads the real
//     status from Bunny, so a spoofed `Status` cannot publish a video that is
//     not actually ready — it can, at worst, cause a refresh.
//
// Answers 2xx for accepted/ignored callbacks, but returns a retryable 5xx when
// database or lifecycle processing fails. The lifecycle is idempotent, so a
// repeated callback is safe and is preferable to silently losing a transition.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import config from "@/lib/config";
import {
  bunnyWebhookIntent,
  bunnyWebhookVideoId,
  describeBunnyWebhookStatus,
  parseBunnyWebhook,
  verifyBunnySignature,
} from "@/lib/bunny-webhook";
import { applyBunnyEncodingEvent } from "@/lib/services/video-encoding.service";
import { recordBunnyWebhookDelivery } from "@/lib/services/bunny-webhook.service";

export async function POST(request: NextRequest) {
  try {
    // The RAW body is required for the signature, so it is read as text and
    // parsed afterwards — never re-serialised.
    const rawBody = await request.text();

    const check = verifyBunnySignature({
      rawBody,
      signature: request.headers.get("X-BunnyStream-Signature") || "",
      version: request.headers.get("X-BunnyStream-Signature-Version"),
      algorithm: request.headers.get("X-BunnyStream-Signature-Algorithm"),
      secret: config.bunny.webhookSecret,
      nodeEnv: config.nodeEnv,
    });

    if (!check.ok) {
      if (check.reason === "not-configured") {
        // A configuration fault, not an attack, and worth its own line: the
        // symptom otherwise looks like Bunny being down.
        console.error(
          "[Bunny Webhook] Refused: BUNNY_STREAM_WEBHOOK_SECRET is not configured, so this callback cannot be verified"
        );
      } else {
        console.error(`[Bunny Webhook] Rejected callback (${check.reason})`);
      }
      // Same body either way: which of the two it was is not the caller's
      // business.
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = parseBunnyWebhook(rawBody);
    if (!payload) {
      return NextResponse.json({ status: "ignored", reason: "unparseable" });
    }

    const bunnyVideoId = bunnyWebhookVideoId(payload);
    if (!bunnyVideoId) {
      return NextResponse.json({ status: "ignored", reason: "no video id" });
    }

    const intent = bunnyWebhookIntent(payload, config.bunny.libraryId);
    const outcome = await applyBunnyEncodingEvent({ bunnyVideoId, intent });

    // Stamp the arrival, so "is Bunny actually calling this deployment?" is
    // answerable on the admin Setup tab instead of unanswerable. Best effort: a
    // cache that cannot be written must never affect a callback that worked.
    const { status, label } = describeBunnyWebhookStatus(payload);
    await recordBunnyWebhookDelivery({
      status,
      label,
      intent,
      matched: outcome.matched,
      published: outcome.published,
      videoId: outcome.videoId,
    });

    console.log(
      `[Bunny Webhook] ${intent} · video ${bunnyVideoId.slice(0, 8)}… → ` +
        (outcome.matched
          ? `row ${outcome.videoId} ${outcome.state ?? "unchanged"}${outcome.published ? " (published)" : ""}`
          : "no matching row")
    );

    return NextResponse.json({
      status: "ok",
      intent,
      matched: outcome.matched,
    });
  } catch (error) {
    console.error("[Bunny Webhook Error]", error);
    return NextResponse.json(
      { status: "retryable_error", error: "Webhook processing failed" },
      { status: 500, headers: { "Retry-After": "10" } }
    );
  }
}
