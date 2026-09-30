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
import { checkRateLimit } from "@/lib/redis";
import { confirmVideoUpload, verifyVideoUploadSession } from "@/lib/video-upload-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({ sessionToken: z.string().min(80).max(20_000) });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // This confirms against the upload host, so a loop here spends provider API
    // calls — bounded per creator, well above a resumable upload's real pace.
    const { allowed } = await checkRateLimit(`upload:${auth.userId}`, 60, 60_000);
    if (!allowed) return api.rateLimited("Too many upload actions — please wait a moment");

    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const session = await verifyVideoUploadSession(parsed.data.sessionToken, auth.userId);
    if (!session) return api.forbidden("This upload session is invalid or belongs to another creator");

    const confirmed = await confirmVideoUpload(session);
    if (!confirmed.ok) {
      // `confirmed.detail` names what the host said and how far it says the file
      // got. That sentence is a diagnosis, so it goes to the log; what comes back
      // to the browser is the one thing the creator can act on.
      console.warn("[Video Upload] not complete:", confirmed.status, confirmed.detail);
      return api.error("The upload is not finished yet. Continue uploading and try again.", 409, "UPLOAD_INCOMPLETE");
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
      "The upload could not be confirmed. Please try again.",
      502,
      "UPLOAD_CONFIRM_FAILED"
    );
  }
}
