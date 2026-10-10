// =============================================================================
// GENHUB - The background clip behind every page (admin)
// GET    /api/admin/background-video - what is set right now
// POST   /api/admin/background-video - start an upload (JSON, small)
// DELETE /api/admin/background-video - take it down
// POST   /api/admin/background-video/complete - confirm one (JSON, small)
//
// The clip an operator can put at the very back of the interface: under the
// aurora, under the grid, under the vignette, seen through every pane of glass.
// See components/BackgroundVideo.tsx for the layer and lib/background-video.ts
// for the rules both halves share.
//
// WHY THIS ROUTE ONLY SIGNS
//
//   The clip can be up to 500 MB, and a serverless function may neither receive
//   nor return more than 4.5 MB. Every earlier shape of this feature died on
//   that one fact: the bytes were written to a disk that does not exist on the
//   deployment, then streamed into memory the platform would not accept, and
//   finally kept in a database — which is fine for a 4 MB clip and no place for
//   a 500 MB one. So the bytes go where a large file belongs: the browser sends
//   them STRAIGHT to Cloudflare R2 against a URL signed here (lib/r2.ts), and the
//   only things this app handles are the signature, the confirmation and the
//   settings row that names the result.
//
// WHY THERE ARE TWO REQUESTS
//
//   The presigned URL is minted before the file moves, so the size, the media
//   type and the destination are all decided and recorded in a signed session
//   first. The confirmation then asks R2 what it actually holds — a claim from
//   the client is not evidence, and a half-finished PUT must not be recorded as
//   live, or the layer would wait on bytes that never arrive.
//
// Guardrails: ADMIN only, 5 uploads per 10 minutes, four containers, 500 MB.
// =============================================================================

import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import {
  PLATFORM_SETTING_KEYS,
  getBackgroundVideo,
  setSetting,
} from "@/lib/services/platform-setting.service";
import {
  MAX_BACKGROUND_VIDEO_BYTES,
  MAX_BACKGROUND_VIDEO_LABEL,
  resolveBackgroundType,
  type BackgroundVideo,
} from "@/lib/background-video";
import {
  isBackgroundVideoUploadConfigured,
  startBackgroundVideoUpload,
} from "@/lib/background-video-session";
import { r2BackgroundKeyFor, r2DeleteObject } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Signing a URL and reading a settings row. The upload itself does not happen
// here, so nothing about this route depends on the size of the clip.
export const maxDuration = 30;

/**
 * What the browser sends to open an upload.
 *
 * No ceiling in the schema: the size bound is checked below so the refusal can
 * name the limit in the same words the picker used. A schema violation reports
 * "number must be less than or equal to 524288000", which is not a sentence an
 * operator can act on.
 */
const startSchema = z.object({
  name: z.string().trim().max(200).optional(),
  mimeType: z.string().trim().max(100).optional(),
  size: z.number().int().positive(),
});

async function currentVideo(): Promise<BackgroundVideo> {
  return getBackgroundVideo();
}

/** Forget the object a stored row names, if it names one. */
async function removeStoredClip(video: BackgroundVideo | null | undefined): Promise<void> {
  if (!video?.active) return;
  const key = r2BackgroundKeyFor(video.token, video.mimeType);
  if (!key) return;
  await r2DeleteObject(key).catch(() => {});
}

// -----------------------------------------------------------------------------
// GET — what the Overview card shows on load.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    await requireRole("ADMIN");
    return api.success({ backgroundVideo: await currentVideo() });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Background Video GET Error]", error);
    return api.internal();
  }
}

// -----------------------------------------------------------------------------
// POST — open an upload and hand the browser a signed destination.
// -----------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const { allowed } = await checkRateLimit(
      `background-video:${auth.userId}`,
      5,
      600_000 // 5 replacements per 10 minutes — this is a rare, deliberate act.
    );
    if (!allowed) {
      return api.rateLimited("Too many background video uploads — wait a few minutes.");
    }

    // Which store and which secret are missing is for the log; the operator can
    // only be told that it is not working, and naming the deployment's own
    // configuration to whoever asks is free reconnaissance.
    if (!isBackgroundVideoUploadConfigured()) {
      console.error(
        "[Background Video] not configured: R2 credentials, R2_BUCKET and JWT_SECRET must all be set"
      );
      return api.error(
        "Video storage is not configured on this deployment. Tell support.",
        503,
        "STORAGE_NOT_CONFIGURED"
      );
    }

    const parsed = startSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return api.error(
        "Choose a video file and try again.",
        422,
        "VALIDATION_ERROR"
      );
    }

    if (parsed.data.size > MAX_BACKGROUND_VIDEO_BYTES) {
      return api.error(
        `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`,
        413,
        "FILE_TOO_LARGE"
      );
    }

    // What the file CLAIMS to be, resolved once. A browser that sends no usable
    // type still gets through on the strength of its extension — see
    // resolveBackgroundType — but a type and a name that disagree with every
    // container we know are refused before anything is signed.
    const resolved = resolveBackgroundType(
      parsed.data.mimeType ?? "",
      parsed.data.name ?? ""
    );
    if (!resolved) {
      return api.error(
        "Choose an MP4, WebM, MOV or MKV video — that file is not one this site can play.",
        422,
        "VALIDATION_ERROR"
      );
    }

    // A fresh token per upload: it is the object's name and the version in the
    // URL, so replacing the clip is a new address and every browser picks it up
    // without a hard refresh.
    const token = randomBytes(12).toString("hex");
    const name = (parsed.data.name || `background${resolved.extension}`).slice(0, 200);

    const upload = await startBackgroundVideoUpload({
      userId: auth.userId,
      token,
      mimeType: resolved.mimeType,
      name,
      size: parsed.data.size,
    });

    return api.success(
      {
        upload: {
          sessionToken: upload.sessionToken,
          token: upload.token,
          uploadUrl: upload.uploadUrl,
          headers: upload.headers,
          expiresAt: upload.expiresAt,
          size: upload.size,
          mimeType: upload.mimeType,
          name: upload.name,
        },
      },
      "Upload started"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Background Video POST Error]", error);
    return api.error(
      "The upload could not be started. Please try again in a moment.",
      502,
      "UPLOAD_SESSION_FAILED"
    );
  }
}

// -----------------------------------------------------------------------------
// DELETE — take it down.
// -----------------------------------------------------------------------------
export async function DELETE() {
  try {
    const auth = await requireRole("ADMIN");

    const previous = await currentVideo();

    // The row goes first. The object is unreferenced the moment the setting is
    // clear, so an interrupted delete leaves an object nothing can reach rather
    // than a page pointing at a clip that is no longer there.
    try {
      await setSetting(
        PLATFORM_SETTING_KEYS.backgroundVideo,
        JSON.stringify({ ...previous, active: false }),
        auth.userId
      );
    } catch (error) {
      console.error("[Background Video] could not clear the setting", error);
      return api.internal("could not clear the background video setting");
    }

    await removeStoredClip(previous);

    if (previous?.active) {
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.featureToggle,
        targetType: "PlatformSetting",
        targetId: PLATFORM_SETTING_KEYS.backgroundVideo,
        summary: `Removed the site background video (${previous.name.slice(0, 120)})`,
        detail: { token: previous.token, name: previous.name, size: previous.size },
      });
    }

    return api.success({ backgroundVideo: await currentVideo() }, "Background video removed");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Background Video DELETE Error]", error);
    return api.internal();
  }
}
