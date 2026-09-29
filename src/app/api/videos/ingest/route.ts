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
// WHY IT CAN BE CALLED MORE THAN ONCE FOR THE SAME VIDEO. One invocation has a
// wall-clock budget shorter than a large file's crossing, so the answer can be
// `ready: false` with how far the transfer got — not a failure, and not a
// partial video: Bunny holds the slices already sent, the next call continues
// from the offset Bunny reports, and a file that fits in one call answers
// `ready: true` on the first try. The page keeps asking until it is ready, which
// is the same shape as the part URLs the browser uses for the upload itself.
//
// IDEMPOTENT BY CONSTRUCTION. The object key is derived from the video id, the
// transfer resumes from Bunny's own offset, and a repeat call on a finished
// upload costs one HEAD and answers `ready: true` — so a retried request, or a
// response lost on the way back, cannot end up with two videos or a second
// two-gigabyte transfer. That is the property Bunny's own fetch API could not
// give (see lib/services/video-ingest.service.ts).
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
// Long enough to move a large slice of a large file, and deliberately longer than
// the transfer's own budget (INGEST_BUDGET_MS, lib/services/video-ingest.service.ts)
// so the abort produces a sentence instead of a killed function. What does NOT
// fit in this budget is continued by the next poll rather than by a bigger limit:
// a route limit is a cliff, and Bunny's own offset is what makes stepping over it
// free.
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
    // ceiling is the same one reserving a slot uses — but multiplied, because
    // this is now POLLED: one large video is several calls by design, and a
    // limit meant for "one upload" would throttle a transfer that is working.
    // Still bounded, and still far below what a script needs.
    const { allowed } = await checkRateLimit(
      `videoingest:${auth.userId}`,
      config.rateLimit.upload.max * 60,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads at once — wait a few minutes and try again");
    }

    const outcome = await ingestUploadedVideo(videoId);

    // Not a failure, and not a success: the transfer is under way and the page
    // should ask again. Answered as a success because every caller that treats
    // this as an error would send a file again that is already being moved.
    if (outcome.ok === false && outcome.pending) {
      return api.success(
        {
          videoId,
          ready: false,
          uploadedBytes: outcome.uploadedBytes ?? 0,
          totalBytes: outcome.totalBytes ?? 0,
        },
        "The video is still being handed over"
      );
    }

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

    return api.success(
      { videoId, ready: true, bytes: outcome.bytes ?? 0 },
      "Video received by the video service"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Ingest Error]", error);
    return api.internal();
  }
}
