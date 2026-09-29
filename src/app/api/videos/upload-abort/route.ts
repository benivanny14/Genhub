// =============================================================================
// GENHUB - Give up on an upload without leaving anything behind
// POST /api/videos/upload-abort  { videoId, uploadId }
//
// Called when the CREATOR cancels, and for no other reason. A failed attempt is
// not an abandoned upload: the page keeps the reserved slot so Retry continues
// into it, and the parts already sent are kept by the bucket under the same
// upload id, which is what makes a retry cost one part instead of the file.
//
// What this exists for is the other ending. An unfinished multipart upload is a
// real entry in the bucket holding every part that was sent, and nothing about it
// expires on its own in any useful timeframe — so a creator who cancels at 90% of
// a 2 GiB file leaves 1.8 GiB being stored and billed, invisible, against a
// library whose empty slots already filled up once. The slot goes too: a
// reservation nobody will fill is the exact shape that did it.
//
// Best effort, both halves. The caller is already handling a cancellation, and an
// abort that fails must not become an error on screen for somebody who just
// pressed cancel — it becomes a line in the log for whoever sweeps the bucket.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { deleteBunnyVideo, isBunnyVideoId } from "@/lib/bunny";
import config from "@/lib/config";
import { abortMultipartUpload, MULTIPART_UPLOAD_ID_RE } from "@/lib/upload-target";
import { isR2Configured } from "@/lib/r2-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  videoId: z.string().min(1, "A video id is required"),
  uploadId: z.string().regex(MULTIPART_UPLOAD_ID_RE, "That is not a valid upload id"),
});

export async function POST(request: NextRequest) {
  try {
    await requireRole("CREATOR");

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return api.validation(parsed.error.errors[0].message);
    }

    const { videoId, uploadId } = parsed.data;
    if (!isBunnyVideoId(videoId)) {
      return api.validation("That is not a valid video id");
    }

    const aborted = isR2Configured(config.r2) ? await abortMultipartUpload(videoId, uploadId) : false;

    // The slot is removed even when the bucket refused the abort: the creator
    // cancelled, so nothing will ever fill it, and the alternative is an empty
    // video in the library that no screen in this application can explain.
    const slotRemoved = await deleteBunnyVideo(videoId)
      .then(() => true)
      .catch(() => false);

    if (!aborted || !slotRemoved) {
      console.warn(
        `[Upload Abort] ${videoId}: bucketAborted=${aborted} slotRemoved=${slotRemoved} — parts or an empty slot may remain`
      );
    }

    return api.success({ aborted, slotRemoved }, "Upload cancelled");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Abort Error]", error);
    return api.internal();
  }
}
