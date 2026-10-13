// =============================================================================
// POST /api/videos/upload-complete
//
// Verifies the staged R2 upload and starts Streamtape's remote import.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import {
  startOrResumeStreamtapeImport,
  verifyStreamtapeUploadSession,
} from "@/lib/streamtape-upload-session";

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

    const session = await verifyStreamtapeUploadSession(parsed.data.sessionToken, auth.userId);
    if (!session) {
      return api.forbidden("This upload session is invalid or belongs to another creator");
    }

    try {
      const result = await startOrResumeStreamtapeImport(session);
      if (result.state === "FAILED" || result.state === "CANCELLED") {
        return api.error("The video could not be sent for processing. Upload it again.", 409, "IMPORT_FAILED");
      }
      return api.success({ state: result.state }, "Streamtape is preparing the video");
    } catch (error) {
      if (error instanceof Error && error.message.includes("staged video")) {
        return api.error(
          "The upload is not complete yet. Continue uploading and try again.",
          409,
          "UPLOAD_INCOMPLETE"
        );
      }
      throw error;
    }
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
