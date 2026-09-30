// =============================================================================
// GENHUB - POST /api/videos/upload-failure
//
// The creator's browser tells us a transfer died. See
// lib/services/upload-failure.service.ts for why this exists at all: the upload
// goes straight to Bunny, so without this the server has no idea it happened.
//
// Three rules shape the route:
//
//   * It answers 200 whenever the report was WELL-FORMED, whether or not the
//     cache could be written. The client is already showing the creator a
//     failure; turning the report into a second error on screen would be a
//     worse outcome than a missing line in a list.
//   * It is rate limited, because the payload is echoed into the admin panel
//     and the log. A creator with a broken connection could otherwise fill the
//     log with one line per retry, and the panel is where someone is trying to
//     read a pattern.
//   * It takes the browser, the origin and the creator from the REQUEST, never
//     from the payload. Those three are the facts the server can observe for
//     itself, and a diagnostic the failing client supplies about itself is
//     worth less than the one it cannot.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { uploadFailureSchema } from "@/lib/validation";
import { recordUploadFailure } from "@/lib/services/upload-failure.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const { allowed } = await checkRateLimit(
      `uploadfail:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many reports at once.");

    const parsed = uploadFailureSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const data = parsed.data;

    // Read from the request rather than from the payload, and read here rather
    // than in the browser: "Opera Mini on a 3G phone" and "Chrome on fibre" are
    // the same NETWORK row otherwise, and they are not the same bug.
    const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;
    // And WHERE the page was loaded from, observed the same way. A PATCH that
    // moved no bytes has two causes that look identical in every other field — a
    // page the host's CORS policy does not allow, and a phone with no usable
    // signal — and this is the field that tells them apart.
    const origin = request.headers.get("origin")?.slice(0, 200) ?? null;

    const entry = await recordUploadFailure({
      code: data.code,
      stage: data.stage ?? null,
      status: data.status ?? null,
      message: data.message,
      providerBody: data.providerBody ?? null,
      reason: data.reason ?? null,
      bunnyVideoId: data.bunnyVideoId ?? null,
      fileName: data.fileName ?? null,
      fileSize: data.fileSize ?? null,
      bytesSent: data.bytesSent ?? null,
      bytesTotal: data.bytesTotal ?? null,
      offset: data.offset ?? null,
      chunkIndex: data.chunkIndex ?? null,
      retryCount: data.retryCount ?? null,
      attemptMs: data.attemptMs ?? null,
      userAgent,
      origin,
      connectionType: data.connectionType ?? null,
      downlinkMbps: data.downlinkMbps ?? null,
      rttMs: data.rttMs ?? null,
      creatorId: auth.userId,
    });

    return api.success({ recorded: true, at: entry.at });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    // Deliberately still a 200-shaped success rather than a 500: the creator is
    // already looking at the failure this report is about, and an error here
    // would be a second, more alarming toast for something they cannot fix.
    console.error("[Upload Failure Report Error]", error);
    return api.success({ recorded: false, at: new Date().toISOString() });
  }
}
