// =============================================================================
// GENHUB - The request that turns parts into the video
// POST /api/videos/upload-complete  { videoId, uploadId, parts: [{partNumber, etag}] }
//
// The last step of the multipart transport, and the only one the browser is not
// allowed to make for itself. Everything before this is reversible — a part that
// never arrived is a part to send again — while this is the request that decides
// which bytes become the creator's video, so it is made here, where the part list
// can be checked, and the part list is covered by the signature (see
// signR2Request: the body is hashed, not sent as UNSIGNED-PAYLOAD).
//
// IT DOES NOT TRUST THE PART NUMBERS. They arrive from a browser, which could
// name the same part twice, or a part that was never sent. R2 refuses a list that
// does not match what it holds, so the refusal is what enforces it — but the
// shape is checked here too, because a malformed list reaching the bucket costs a
// round trip to learn what a schema can say immediately, and because a duplicate
// part number in the XML is a request that can only ever fail.
//
// It does NOT hand the file to Bunny either. That is the next request
// (api/videos/ingest), unchanged: it is a different wait, reported differently,
// and keeping it separate is what lets a finished transfer fail with "could not be
// prepared" rather than with "the upload failed".
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { isBunnyVideoId } from "@/lib/bunny";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { completeMultipartUpload, type CompletedPart } from "@/lib/upload-target";
import { isR2Configured, StorageError } from "@/lib/r2-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_ID_RE = /^[A-Za-z0-9+/=_-]{1,300}$/;

const schema = z.object({
  videoId: z.string().min(1, "A video id is required"),
  uploadId: z.string().regex(UPLOAD_ID_RE, "That is not a valid upload id"),
  // Bounded on both ends. An empty list cannot make an object, and 10,000 is the
  // S3 ceiling on parts — a longer list is a request that was refused before it
  // was sent, and saying so here is cheaper than a round trip.
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        // An ETag is a quoted hex digest. The quotes are part of the value R2
        // hands back and part of the value it will match against, so they are
        // kept verbatim rather than trimmed.
        etag: z.string().min(2).max(200),
      })
    )
    .min(1)
    .max(10_000),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return api.validation(parsed.error.errors[0].message);
    }

    const { videoId, uploadId, parts } = parsed.data;

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

    // A listed part number that appears twice makes an XML document no bucket can
    // accept, and a list that skips a number is a file with a hole in it. Neither
    // is worth a round trip.
    const seen = new Set<number>();
    for (const part of parts) {
      if (seen.has(part.partNumber)) {
        return api.validation(`Part ${part.partNumber} was listed twice`);
      }
      seen.add(part.partNumber);
    }

    const { allowed } = await checkRateLimit(
      `uploadcomplete:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads at once — wait a few minutes and try again");
    }

    const ordered: CompletedPart[] = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    // A gap means a part the browser believes it sent was never recorded, which
    // is the one failure that would otherwise produce a playable video with the
    // middle missing: R2 accepts a list of parts that are not contiguous when the
    // numbers are not contiguous either, so the check has to be ours.
    const missing: number[] = [];
    for (let expected = 1; expected <= ordered.length; expected += 1) {
      if (ordered[expected - 1].partNumber !== expected) missing.push(expected);
    }
    if (missing.length > 0) {
      return api.error(
        "Part of the upload did not reach storage, so the video would be incomplete. Please upload it again.",
        409,
        "INCOMPLETE_UPLOAD"
      );
    }

    try {
      await completeMultipartUpload(videoId, uploadId, ordered);
    } catch (error) {
      // The bucket's own words, logged for the operator and never shown to the
      // creator: what they can act on is that the transfer has to be sent again.
      console.error(`[Upload Complete] ${videoId}:`, error);

      if (error instanceof StorageError) {
        return api.error(
          "The video storage would not finish this upload. Please upload it again — if it keeps happening, tell support.",
          502,
          "STORAGE_REFUSED"
        );
      }
      return api.internal();
    }

    return api.success({ videoId, parts: ordered.length }, "Upload assembled");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Complete Error]", error);
    return api.internal();
  }
}
