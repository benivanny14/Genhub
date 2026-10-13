// =============================================================================
// POST /api/videos/upload-abort { sessionToken }
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import prisma from "@/lib/db";
import {
  cancelStreamtapeUpload,
  verifyStreamtapeUploadSession,
} from "@/lib/streamtape-upload-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ sessionToken: z.string().min(80).max(20_000) });

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const { allowed } = await checkRateLimit(`upload:${auth.userId}`, 60, 60_000);
    if (!allowed) return api.rateLimited("Too many upload actions — please wait a moment");

    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const session = await verifyStreamtapeUploadSession(parsed.data.sessionToken, auth.userId);
    if (!session) {
      return api.forbidden("This upload session is invalid or belongs to another creator");
    }

    const upload = await prisma.streamtapeUpload.findUnique({
      where: { id: session.uploadId },
      select: { state: true, streamtapeFileId: true },
    });
    const linked =
      upload?.state === "LINKED" ||
      (upload?.streamtapeFileId
        ? Boolean(
            await prisma.video.findFirst({
              where: { streamtapeFileId: upload.streamtapeFileId, isDeleted: false },
              select: { id: true },
            })
          )
        : false);
    if (linked) return api.error("This upload is already attached to a video", 409, "UPLOAD_LINKED");

    await cancelStreamtapeUpload(session);
    return api.success({ videoId: session.uploadId }, "Upload cancelled");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Video Upload Abort Error]", error);
    return api.internal();
  }
}
