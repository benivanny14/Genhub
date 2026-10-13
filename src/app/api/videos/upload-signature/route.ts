// =============================================================================
// POST /api/videos/upload-signature
//
// Creates an R2 staging upload signed for one object and one PUT. After the
// browser sends the bytes, the server asks Streamtape to import and convert it.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import config from "@/lib/config";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import {
  createStreamtapeUploadSession,
  isStreamtapeUploadConfigured,
} from "@/lib/streamtape-upload-session";
import { MAX_VIDEO_BYTES } from "@/lib/video-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({
  title: z.string().trim().min(1).max(200),
  fileName: z.string().trim().min(1).max(200).optional(),
  size: z.number().int().positive().max(MAX_VIDEO_BYTES),
  /**
   * What the device called the file — a HINT, never a gate.
   *
   * Provider MIME guesses are inconsistent: `.mkv` files, camera recordings
   * and downloads may arrive as an empty string or `application/octet-stream`.
   *
   * Streamtape inspects the imported file. The browser-reported MIME type only
   * selects the signed R2 content-type header; unknown types use video/mp4.
   */
  mimeType: z.string().trim().max(100).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");
    const prisma = (await import("@/lib/db")).default;

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { kycStatus: true, isBanned: true },
    });

    if (!user || user.kycStatus !== "APPROVED") {
      return api.forbidden("Your KYC must be approved before you can upload videos");
    }
    if (user.isBanned) return api.forbidden("Your account is blocked");

    const { allowed } = await checkRateLimit(
      `video-upload:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads at once — wait a few minutes and try again");
    }

    const held = await prisma.video.count({
      where: { creatorId: auth.userId, isDeleted: false },
    });
    if (held >= config.business.maxVideosPerCreator) {
      return api.forbidden(
        `This account already holds ${held} videos, which is the limit. Delete an old video or contact support.`
      );
    }

    // Two independent settings, and which one is missing is a fact for the log
    // and for support — not for the response. A creator cannot act on either
    // name, and naming the deployment's own configuration to whoever asked is
    // free reconnaissance, so the response carries one sentence and the two
    // causes are written where an operator will actually read them.
    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    if (!isStreamtapeUploadConfigured()) {
      console.error("[Video Upload] Streamtape, R2 or upload-session signing is not configured");
      return api.error("Video uploads are temporarily unavailable. Tell support.", 503, "NOT_CONFIGURED");
    }

    const session = await createStreamtapeUploadSession({
      userId: auth.userId,
      fileName: parsed.data.fileName || parsed.data.title,
      totalBytes: parsed.data.size,
      mimeType: parsed.data.mimeType,
    });

    return api.success(session, "Upload session created");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Upload Session Error]", error);
    return api.error(
      "The upload could not be started. Please try again in a moment.",
      502,
      "UPLOAD_SESSION_FAILED"
    );
  }
}
