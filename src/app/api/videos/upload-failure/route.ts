// =============================================================================
// GENHUB - Failed video upload report
// POST /api/videos/upload-failure
//
// The creator's browser tells us a transfer died. See
// lib/services/upload-failure.service.ts for why this exists at all: the upload
// goes straight to Bunny, so without this the server has no idea it happened.
//
// Two rules shape the route:
//
//   * It answers 200 whenever the report was WELL-FORMED, whether or not the
//     cache could be written. The client is already showing the creator a
//     failure; turning the report into a second error on screen would be a
//     worse outcome than a missing line in a list.
//   * It is rate limited, because the payload is echoed into the admin panel
//     and the log. A creator with a broken connection could otherwise fill the
//     log with one line per retry, and the panel is where someone is trying to
//     read a pattern.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { uploadFailureSchema } from "@/lib/validation";
import { recordUploadFailure } from "@/lib/services/upload-failure.service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const { allowed } = await checkRateLimit(
      `uploadfail:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many reports at once.");
    }

    const body = await request.json().catch(() => null);
    const parsed = uploadFailureSchema.safeParse(body);
    if (!parsed.success) {
      return api.validation(parsed.error.errors[0].message);
    }

    const {
      code,
      stage,
      status,
      message,
      providerBody,
      bunnyVideoId,
      fileName,
      fileSize,
      bytesSent,
      bytesTotal,
      reason,
      offset,
      chunkIndex,
      retryCount,
      attemptMs,
      connectionType,
      downlinkMbps,
      rttMs,
    } = parsed.data;

    // Read from the request rather than from the payload, and read here rather
    // than in the browser: this is the one fact about the failing client that
    // the server can observe for itself. "A phone on Opera Mini" and "Chrome on
    // WiFi" are the same NETWORK row otherwise, and they are not the same bug.
    const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;

    await recordUploadFailure({
      code,
      stage: stage ?? null,
      status: status ?? null,
      message,
      providerBody: providerBody ?? null,
      bunnyVideoId: bunnyVideoId ?? null,
      fileName: fileName ?? null,
      fileSize: fileSize ?? null,
      bytesSent: bytesSent ?? null,
      bytesTotal: bytesTotal ?? null,
      reason: reason ?? null,
      offset: offset ?? null,
      chunkIndex: chunkIndex ?? null,
      retryCount: retryCount ?? null,
      attemptMs: attemptMs ?? null,
      userAgent,
      connectionType: connectionType ?? null,
      downlinkMbps: downlinkMbps ?? null,
      rttMs: rttMs ?? null,
      creatorId: auth.userId,
    });

    return api.success({ recorded: true }, "Failure recorded");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Upload Failure Report Error]", error);
    return api.internal();
  }
}
