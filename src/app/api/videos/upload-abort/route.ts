// =============================================================================
// POST /api/videos/upload-abort { sessionToken }
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import prisma from "@/lib/db";
import {
  abortVideoUploadSession,
  verifyVideoUploadSession,
} from "@/lib/video-upload-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ sessionToken: z.string().min(80).max(20_000) });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");
    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const session = await verifyVideoUploadSession(parsed.data.sessionToken, auth.userId);
    if (!session) return api.forbidden("This upload session is invalid or belongs to another creator");

    // A valid session token remains in the browser after publishing. Never let
    // a delayed cancel request delete a Bunny asset already linked to a post.
    const linked = await prisma.video.findFirst({
      where: {
        OR: [{ bunnyVideoId: session.videoId }, { teaserBunnyVideoId: session.videoId }],
        isDeleted: false,
      },
      select: { id: true },
    });
    if (linked) return api.error("This upload is already attached to a video", 409, "UPLOAD_LINKED");

    await abortVideoUploadSession(session);
    return api.success({ videoId: session.videoId }, "Upload cancelled");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Upload Abort Error]", error);
    return api.internal();
  }
}
