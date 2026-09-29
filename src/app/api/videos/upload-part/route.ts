// =============================================================================
// GENHUB - One URL for one part of a video
// POST /api/videos/upload-part  { videoId, uploadId, partNumber }
//
// The middle request of the multipart transport. The browser has a file too big
// for one request, the server has already told the bucket to expect it in parts
// (api/videos/upload-signature), and this is what lets the browser send part 7
// without holding anything that could send part 8.
//
// WHY ONE PART AT A TIME, AND NOT A LIST UP FRONT. A 2 GiB file is 256 parts, so
// a plan would be 256 signed URLs in one response, every one of them expiring
// while the creator waits through the ones before it. This way each URL is signed
// when it is about to be used, which is also what makes a part retried twenty
// minutes into an upload possible at all.
//
// WHY THE URL CANNOT BE REUSED FOR ANOTHER PART. `partNumber` and `uploadId` are
// inside the signature (lib/r2-sign.ts), so a URL minted for part 3 answers 403
// as part 4 — measured against the live bucket, and asserted in
// tests/r2-sign.test.ts. Without that, a part URL would be a licence to overwrite
// any part of any upload, which is the whole reason this route signs rather than
// hands out a bucket credential.
//
// The object key is never accepted from the client: it is derived from the video
// id (lib/upload-target.ts), so a creator cannot be pointed at another creator's
// object by a request they control.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { isBunnyVideoId } from "@/lib/bunny";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { MULTIPART_UPLOAD_ID_RE, signPartUpload } from "@/lib/upload-target";
import { isR2Configured } from "@/lib/r2-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The upload id's shape is checked against ONE rule shared by all three routes
// (MULTIPART_UPLOAD_ID_RE, lib/upload-target.ts). It is not matched against
// anything this server stored, because this server keeps no multipart state —
// the bucket does — and what the check buys is that nothing with a slash, a
// query delimiter or a newline can reach the signer, so a crafted id cannot sign
// a URL for a different object than the one this request names.
const schema = z.object({
  videoId: z.string().min(1, "A video id is required"),
  uploadId: z.string().regex(MULTIPART_UPLOAD_ID_RE, "That is not a valid upload id"),
  partNumber: z.number().int().min(1).max(10_000),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const failed = parsed.error.errors[0];
      // The LENGTH only, never the id itself. When this rule was wrong it refused
      // a real 343-character id with a sentence that named no number, and finding
      // that out took a live probe against the bucket; one line here would have
      // said it outright.
      if (failed.path[0] === "uploadId" && typeof body?.uploadId === "string") {
        console.warn(
          `[Upload Part] refused an upload id of ${body.uploadId.length} characters — see MULTIPART_UPLOAD_ID_RE`
        );
      }
      return api.validation(failed.message);
    }

    const { videoId, uploadId, partNumber } = parsed.data;

    // Same rule as the ingest: only a real Bunny id names a slot, and this route
    // is the only thing that decides which object a part is written to.
    if (!isBunnyVideoId(videoId)) {
      return api.validation("That is not a valid video id");
    }

    if (!isR2Configured(config.r2)) {
      return api.error(
        "Video uploads are not available right now — the upload storage is not configured. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }

    // Signing is cheap but not free, and a part is 8 MiB: the ceiling that
    // matters is how many parts one creator can ask for in a window, and that is
    // the same ceiling the reservation uses. A 2 GiB file is 256 requests of its
    // own, so this has to be far above a human and far below a script.
    const { allowed } = await checkRateLimit(
      `uploadpart:${auth.userId}`,
      config.rateLimit.upload.max * 40,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many upload requests at once — wait a few minutes and try again");
    }

    const target = signPartUpload(videoId, uploadId, partNumber);
    return api.success({ partNumber, ...target }, "Part URL signed");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Part Error]", error);
    return api.internal();
  }
}
