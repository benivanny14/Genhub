import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { cacheDel, checkRateLimit } from "@/lib/redis";
import {
  pollStreamtapeImport,
  verifyStreamtapeUploadSession,
} from "@/lib/streamtape-upload-session";
import prisma from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

    const status = await pollStreamtapeImport(session);
    if (status.state === "READY" && status.fileId) {
      await prisma.video.updateMany({
        where: { creatorId: auth.userId, streamtapeFileId: `pending_${session.uploadId}` },
        data: { streamtapeFileId: status.fileId, encodingStatus: null, encodeProgress: 100 },
      });
      await prisma.streamtapeUpload.updateMany({
        where: { id: session.uploadId, state: "READY" },
        data: { state: "LINKED" },
      });
      await cacheDel("home:feed:v3");
      await cacheDel("videos:*");
    }
    return api.success(status);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Streamtape Upload Status Error]", error);
    return api.error("The video is still being prepared. Try checking again shortly.", 503, "IMPORT_STATUS_FAILED");
  }
}
