// =============================================================================
// GENHUB - Hand a finished upload to Bunny
// POST /api/videos/ingest  { videoId }
//
// The last step of the presigned upload path. The browser has PUT the file into
// the bucket and stops there; this asks worker/video-ingest to move that object
// into the slot reserved for this video, and answers only when Bunny has the
// file — so the post that follows is created against a video that really exists.
//
// WHY ITS OWN ROUTE, and not a step inside POST /api/videos: this request lasts
// as long as a video takes to cross from one provider to another, and the
// request that writes the creator's post must not inherit that. Kept apart, a
// slow ingest delays "Preparing…" instead of the publish, and a failed one is
// reported as its own sentence rather than as a failed post.
//
// IDEMPOTENT BY CONSTRUCTION. The object key and the video id both come from the
// token, and the ingest writes the same bytes into the same slot, so a creator
// who retries — or a client that retries the request — cannot end up with two
// videos. That is the property Bunny's own fetch API could not give (see
// lib/services/video-ingest.service.ts).
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { isBunnyVideoId } from "@/lib/bunny";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import {
  describeIngestFailure,
  ingestUploadedVideo,
} from "@/lib/services/video-ingest.service";

export const runtime = "nodejs";
// A whole video moving between providers, on a good network between two of them.
// The default budget would cut a large ingest, and a cut ingest is a creator
// told to upload again for no reason.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const schema = z.object({
  videoId: z.string().min(1, "A video id is required"),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return api.validation(parsed.error.errors[0].message);
    }

    const { videoId } = parsed.data;

    // Only a real Bunny id can name a slot. Anything else — a fabricated string,
    // a demo row's synthetic id — has no reserved video behind it, so asking
    // Bunny to fill it would create confusion rather than a video.
    if (!isBunnyVideoId(videoId)) {
      return api.validation("That is not a valid video id");
    }

    // Every call moves a whole file and costs egress on two providers, so the
    // same ceiling as reserving a slot: far above a creator retrying, far below
    // a script.
    const { allowed } = await checkRateLimit(
      `videoingest:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads at once — wait a few minutes and try again");
    }

    const outcome = await ingestUploadedVideo(videoId);

    if (!outcome.ok) {
      // 503 for a deployment that cannot do this at all, 502 for a provider that
      // answered badly, 409 for a file that never arrived: the creator's next
      // action differs between them (tell support / try again / upload again).
      const status = outcome.reason === "not-configured" ? 503 : outcome.reason === "not-uploaded" ? 409 : 502;
      // The reason travels as the error CODE rather than a body field, so the
      // client can branch on it without parsing prose, and the detail is logged
      // rather than shown: it is Bunny's or a Worker's wording, not the
      // creator's.
      console.error(
        `[Video Ingest] ${outcome.reason ?? "failed"} for ${videoId}: ${outcome.detail ?? "no detail"}`
      );
      return api.error(
        describeIngestFailure(outcome),
        status,
        (outcome.reason ?? "failed").toUpperCase()
      );
    }

    return api.success({ videoId, ready: true }, "Video received by the video service");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Ingest Error]", error);
    return api.internal();
  }
}
