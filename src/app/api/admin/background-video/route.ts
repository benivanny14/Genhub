// =============================================================================
// GENHUB - The background clip behind every page (admin)
// GET    /api/admin/background-video - what is set right now
// POST   /api/admin/background-video - replace it (raw body)
// DELETE /api/admin/background-video - take it down
//
// The clip an operator can put at the very back of the interface: under the
// aurora, under the grid, under the vignette, seen through every pane of glass.
// See components/BackgroundVideo.tsx for the layer and lib/background-video.ts
// for the rules both halves share.
//
// WHY THE BODY IS NOT multipart/form-data
//
//   `request.formData()` assembles the whole upload in memory before this
//   handler sees a single field, and the one number that matters — the size —
//   would not be known until it had already been paid for. The client sends the
//   file itself as the body with its name and size in headers, and this route
//   reads it through a counter that stops at the ceiling, so an oversized body is
//   abandoned while it is still arriving and a refused upload costs only the
//   bytes it managed to send.
//
// WHERE IT IS STORED
//
//   A row in the database (BackgroundVideoAsset), written and read through
//   lib/services/background-video.service.ts. It was a file in
//   `public/uploads/site/` until that was measured against the deployment, where
//   `public/` is read-only, `/tmp` is per-instance and discarded, and a function
//   may neither receive nor return more than 4.5 MB — so the clip could not be
//   written at all, and the 413 that answered a 6 MB upload came from the
//   platform, not from this code. The bytes now travel in one request in each
//   direction, which is why the ceiling is small enough to fit: see
//   MAX_BACKGROUND_VIDEO_BYTES.
//
// Guardrails: ADMIN only, 5 uploads per 10 minutes, four containers, 4 MB.
// =============================================================================

import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";
import {
  PLATFORM_SETTING_KEYS,
  getBackgroundVideo,
  setSetting,
} from "@/lib/services/platform-setting.service";
import {
  deleteBackgroundVideoAsset,
  saveBackgroundVideoAsset,
} from "@/lib/services/background-video.service";
import {
  MAX_BACKGROUND_VIDEO_BYTES,
  MAX_BACKGROUND_VIDEO_LABEL,
  backgroundVideoAssetId,
  looksLikeBackgroundVideo,
  resolveBackgroundType,
  type BackgroundVideo,
} from "@/lib/background-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One request, one small file. The ceiling is answered from the declared size
// before the body is read, and the read itself is bounded, so this only has to
// outlast a slow phone sending a few megabytes.
export const maxDuration = 60;

/** Raised by the reader when the stream passes the ceiling. */
class UploadTooLarge extends Error {
  constructor() {
    super("upload exceeds the background video limit");
  }
}

async function currentVideo(): Promise<BackgroundVideo> {
  return getBackgroundVideo();
}

/**
 * Read the body, refusing to grow past the ceiling.
 *
 * The counter is on the CHUNKS rather than on a length header, because a
 * declared length is a claim: a client can send `Content-Length: 1024` and then
 * 800 MB, and a route that trusts it has allocated all of it. The chunks are
 * collected and joined once, so a 4 MB clip costs one 4 MB buffer and an
 * oversized one is dropped the moment it crosses the line.
 */
async function readBodyWithin(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > limit) throw new UploadTooLarge();
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Stops the request body being read further once we have decided. A no-op
    // when the stream has already ended, which is the common path.
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks, bytes);
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
// POST — replace it.
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

    // What the file CLAIMS to be, resolved once. A browser that sends no usable
    // type still gets through on the strength of its extension — see
    // resolveBackgroundType — but a type and a name that disagree with every
    // container we know are refused before a byte is read.
    const declaredType = request.headers.get("content-type") ?? "";
    let fileName = "";
    try {
      fileName = decodeURIComponent(request.headers.get("x-filename") ?? "");
    } catch {
      fileName = "";
    }
    const resolved = resolveBackgroundType(declaredType, fileName);
    if (!resolved) {
      return api.validation(
        `Upload an MP4, WebM, MOV or MKV video (max ${MAX_BACKGROUND_VIDEO_LABEL})`
      );
    }

    // Refused on the declared length so an oversized body is answered without
    // being read at all, and again by the counter while it arrives for a client
    // that lied about it. BOTH numbers are checked because they fail differently:
    // `content-length` is what an ordinary browser sends, `x-file-size` is what
    // the client worked out before it opened the file and is all there is when
    // the body is chunked.
    const tooLarge = `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`;
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKGROUND_VIDEO_BYTES) {
      return api.error(tooLarge, 413, "FILE_TOO_LARGE");
    }
    const declaredSize = Number(request.headers.get("x-file-size") ?? "");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BACKGROUND_VIDEO_BYTES) {
      return api.error(tooLarge, 413, "FILE_TOO_LARGE");
    }

    if (!request.body) {
      return api.validation("The upload was empty — choose a video and try again.");
    }

    let data: Buffer;
    try {
      data = await readBodyWithin(request.body, MAX_BACKGROUND_VIDEO_BYTES);
    } catch (error) {
      if (error instanceof UploadTooLarge) return api.error(tooLarge, 413, "FILE_TOO_LARGE");
      throw error;
    }

    if (data.byteLength === 0) {
      return api.validation("That file is empty.");
    }

    // The bytes, not the label. A MIME type and an extension are both claims;
    // this is the file's own first bytes, and an executable wearing a video's
    // name is never stored under a video's content type.
    if (!looksLikeBackgroundVideo(data, resolved.extension)) {
      return api.validation(
        "That file is not a video this site can play. Choose an MP4, WebM, MOV or MKV file."
      );
    }

    const previous = await currentVideo();

    // A fresh token per upload: it is the key of the stored clip and the version
    // in the URL, so replacing the clip is a new address and every browser picks
    // it up without a hard refresh.
    const token = randomBytes(12).toString("hex");
    const backgroundVideo: BackgroundVideo = {
      active: true,
      token,
      mimeType: resolved.mimeType,
      name: (fileName || `background.${resolved.extension.slice(1)}`).slice(0, 200),
      size: data.byteLength,
    };

    try {
      await saveBackgroundVideoAsset({
        id: token,
        mimeType: resolved.mimeType,
        name: backgroundVideo.name,
        data,
      });
    } catch (error) {
      // Which store could not be written is for the log: the admin can only be
      // told that it did not stick.
      console.error("[Background Video] could not store the upload", error);
      return api.error(
        "This server cannot store a video right now. Try again, or ask support.",
        503,
        "STORAGE_NOT_CONFIGURED"
      );
    }

    try {
      await setSetting(
        PLATFORM_SETTING_KEYS.backgroundVideo,
        JSON.stringify(backgroundVideo),
        auth.userId
      );
    } catch (error) {
      // The clip is stored but no row points at it: remove it, or it is an
      // orphan nothing will ever serve or clean up.
      await deleteBackgroundVideoAsset(token).catch(() => {});
      console.error("[Background Video] could not save the setting", error);
      return api.internal("could not persist the background video setting");
    }

    // The old clip goes only once the new one is recorded. Deleting first would
    // leave the site with no backdrop at all if the write below failed.
    if (previous?.active) {
      await deleteBackgroundVideoAsset(backgroundVideoAssetId(previous)).catch(() => {});
    }

    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.featureToggle,
      targetType: "PlatformSetting",
      targetId: PLATFORM_SETTING_KEYS.backgroundVideo,
      summary: `Replaced the site background video (${backgroundVideo.name.slice(0, 120)})`,
      detail: {
        token,
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
    console.error("[Background Video POST Error]", error);
    return api.internal();
  }
}

// -----------------------------------------------------------------------------
// DELETE — take it down.
// -----------------------------------------------------------------------------
export async function DELETE() {
  try {
    const auth = await requireRole("ADMIN");

    const previous = await currentVideo();

    // The row goes first. The bytes are unreferenced the moment the setting is
    // clear, so an interrupted delete leaves an orphan nobody can reach rather
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

    await deleteBackgroundVideoAsset(backgroundVideoAssetId(previous)).catch(() => {});

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
