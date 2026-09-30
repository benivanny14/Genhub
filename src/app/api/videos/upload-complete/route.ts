// =============================================================================
// POST /api/videos/upload-complete
//
// Confirms that Bunny's TUS resource contains every byte. It does not create a
// database row; the metadata route does that after this check. Keeping the two
// steps separate makes retries idempotent and lets teaser uploads use the same
// transport without creating a video post.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { confirmVideoUpload, verifyVideoUploadSession } from "@/lib/video-upload-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({ sessionToken: z.string().min(80).max(20_000) });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");
    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const session = await verifyVideoUploadSession(parsed.data.sessionToken, auth.userId);
    if (!session) return api.forbidden("This upload session is invalid or belongs to another creator");

    const confirmed = await confirmVideoUpload(session);
    if (!confirmed.ok) {
      return api.error(
        `Upload is not complete yet (${confirmed.detail}). Continue uploading and try again.`,
        409,
        "UPLOAD_INCOMPLETE"
      );
    }

    return api.success(
      { videoId: session.videoId, totalBytes: session.totalBytes },
      "Upload confirmed"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Upload Complete Error]", error);
    return api.error(
      "The video service could not confirm this upload. Please try again.",
      502,
      "UPLOAD_CONFIRM_FAILED"
    );
  }
}
