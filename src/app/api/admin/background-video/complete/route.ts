// =============================================================================
// GENHUB - Confirm a background clip upload (admin)
// POST /api/admin/background-video/complete  { sessionToken }
//
// The second half of the transport in ../route.ts: the browser has finished
// sending the file to R2, and this is where the result becomes the site's
// backdrop.
//
// THE CLAIM IS NOT THE EVIDENCE
//
//   The client says it uploaded. R2 is asked instead — a HEAD against the object
//   the session named, and the number that comes back is the one recorded. A PUT
//   that was refused, or that died at 90%, leaves no object (or a partial one),
//   and recording it as live would put a clip behind every page that plays
//   nothing at all, with no way for the operator to tell that from a clip the
//   browser cannot decode.
//
//   The session also has to be one THIS SERVER issued, to THIS admin, over the
//   key it names: without that check, "make this token live" would be an
//   instruction any caller could give, and the settings row would point at an
//   object nobody uploaded.
//
// THE PREVIOUS CLIP GOES LAST, AND ONLY IF THE NEW ONE STUCK
// =============================================================================

import { NextRequest } from "next/server";
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
  isBackgroundVideoUploadConfigured,
  verifyBackgroundVideoUpload,
} from "@/lib/background-video-session";
import { r2BackgroundKeyFor, r2DeleteObject, r2HeadObject } from "@/lib/r2";
import type { BackgroundVideo } from "@/lib/background-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({
  sessionToken: z.string().trim().min(20).max(4096),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const { allowed } = await checkRateLimit(
      `background-video-confirm:${auth.userId}`,
      20,
      600_000 // A confirmation is cheap and may be retried; the upload is the rare act.
    );
    if (!allowed) return api.rateLimited("Too many attempts — wait a minute and try again.");

    if (!isBackgroundVideoUploadConfigured()) {
      console.error(
        "[Background Video] could not confirm: R2 credentials, R2_BUCKET and JWT_SECRET must all be set"
      );
      return api.error(
        "Video storage is not configured on this deployment. Tell support.",
        503,
        "STORAGE_NOT_CONFIGURED"
      );
    }

    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return api.validation("That upload session is not readable.");

    const upload = await verifyBackgroundVideoUpload(parsed.data.sessionToken, auth.userId);
    if (!upload) {
      // Expired, tampered with, or issued to somebody else. Nothing about which
      // of those it was belongs in the response.
      return api.error(
        "That upload is no longer open. Choose the video again.",
        409,
        "UPLOAD_SESSION_INVALID"
      );
    }

    const stored = await r2HeadObject(upload.key);
    if (!stored) {
      // The most likely cause is a transfer that did not finish, and the client
      // still holds a valid signed URL for exactly this object — so it is told
      // to try again rather than to start over.
      return api.error(
        "That upload did not finish. Press Upload again and it will resume.",
        409,
        "UPLOAD_NOT_FOUND"
      );
    }

    const backgroundVideo: BackgroundVideo = {
      active: true,
      token: upload.token,
      mimeType: upload.mimeType,
      name: upload.name,
      // R2's own count, not the client's estimate: this is the number every
      // range decision and the operator's own card are built from.
      size: stored.size,
    };

    const previous = await getBackgroundVideo();

    try {
      await setSetting(
        PLATFORM_SETTING_KEYS.backgroundVideo,
        JSON.stringify(backgroundVideo),
        auth.userId
      );
    } catch (error) {
      console.error("[Background Video] could not save the setting", error);
      return api.internal("could not persist the background video setting");
    }

    // The old object goes only once the new row is written. Deleting first would
    // leave the site with no backdrop at all if the write above had failed.
    if (previous?.active && previous.token !== backgroundVideo.token) {
      const oldKey = r2BackgroundKeyFor(previous.token, previous.mimeType);
      if (oldKey) await r2DeleteObject(oldKey).catch(() => {});
    }

    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.featureToggle,
      targetType: "PlatformSetting",
      targetId: PLATFORM_SETTING_KEYS.backgroundVideo,
      summary: `Replaced the site background video (${backgroundVideo.name.slice(0, 120)})`,
      detail: {
        token: backgroundVideo.token,
        mimeType: backgroundVideo.mimeType,
        name: backgroundVideo.name,
        size: backgroundVideo.size,
        replaced: previous?.active ? previous.name : null,
      },
    });

    return api.success({ backgroundVideo }, "Background video updated");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Background Video Complete Error]", error);
    return api.internal();
  }
}
