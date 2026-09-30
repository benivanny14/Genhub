// =============================================================================
// POST /api/videos/upload-signature
//
// Starts the only video transport used by Genhub. The server creates a Bunny
// video slot and a resumable TUS resource, then returns a signed session. The
// browser sends every video byte directly to Bunny; Vercel, R2 and a Worker are
// not in the data path.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { isBunnyConfigured } from "@/lib/bunny";
import { createVideoUploadSession, isUploadSessionConfigured } from "@/lib/video-upload-session";
import { MAX_VIDEO_BYTES } from "@/lib/video-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({
  title: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_VIDEO_BYTES),
  /**
   * What the device called the file — a HINT, never a gate.
   *
   * This used to refuse anything that did not start with `video/`, and the
   * intent behind that was good: keep a creator from pushing a 2 GB document
   * through a video pipeline. What it did in practice was refuse the videos.
   * The value comes from the picker, and on Android that is the document
   * provider's guess: a `.mkv` off an SD card, a `.mov` a camera app wrote
   * itself, anything downloaded by a chat app arrives as an empty string or as
   * `application/octet-stream`, and every one of them was turned away here with
   * "Choose a video file" — for a file the creator had just chosen and could
   * see playing in their gallery.
   *
   * Bunny decides what a file is by reading its bytes, and the encoding
   * lifecycle already takes down anything that turns out not to be a video, so
   * nothing is gained by guessing first. Bounded in length only.
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

    // Two independent settings, named separately. The session token is a JWT
    // and the library key is Bunny's, so either one missing makes every upload
    // fail — and "could not start this upload" sends an operator to the wrong
    // console half the time.
    if (!isBunnyConfigured()) {
      return api.error(
        "Video uploads are not configured on this deployment: the Bunny Stream library key is missing. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }
    if (!isUploadSessionConfigured()) {
      return api.error(
        "Video uploads are not configured on this deployment: JWT_SECRET is missing or still the development default, so no upload session can be signed. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const session = await createVideoUploadSession({
      userId: auth.userId,
      title: parsed.data.title,
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
      "The video service could not start this upload. Please try again in a moment.",
      502,
      "UPLOAD_SESSION_FAILED"
    );
  }
}
