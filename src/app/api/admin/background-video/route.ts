// =============================================================================
// GENHUB - The background clip behind every page (admin)
// GET    /api/admin/background-video - what is set right now
// POST   /api/admin/background-video - replace it (raw body, streamed)
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
//   handler sees a single field, so an 800 MB clip would be 800 MB of heap —
//   and the one number that matters, the size, would not be known until it had
//   already been paid for. The client sends the file itself as the body with
//   its name and size in headers, and this route pipes the stream straight to
//   disk through a counter that stops at the ceiling. Memory stays flat, the
//   limit is enforced WHILE the bytes arrive, and a rejected upload costs only
//   the bytes it managed to send.
//
// WHERE IT IS STORED
//
//   `public/uploads/site/` — the directory the image route already writes to,
//   which is gitignored, and which only this route and the public serving route
//   ever name. Bunny is the storage for the CATALOGUE and its uploads go
//   through a TUS session sized for 2 GB; a single site-wide backdrop is a
//   different shape (one file, one reader, replaced not appended), and putting
//   it here keeps it on the same disk as the deployment. On a host whose disk
//   is read-only the write fails and the operator gets one plain sentence
//   instead of a silently missing backdrop.
//
// Guardrails: ADMIN only, 5 uploads per 10 minutes, four containers, 800 MB.
// =============================================================================

import { NextRequest } from "next/server";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  MAX_BACKGROUND_VIDEO_BYTES,
  MAX_BACKGROUND_VIDEO_LABEL,
  backgroundVideoRelativePath,
  looksLikeBackgroundVideo,
  resolveBackgroundType,
  type BackgroundVideo,
} from "@/lib/background-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A clip near the ceiling on an ordinary connection takes minutes, and a
// platform that kills its own operator's upload halfway is a platform that
// looks like it has no ceiling at all.
export const maxDuration = 300;

/** Raised by the counter when the stream passes 800 MB. */
class UploadTooLarge extends Error {
  constructor() {
    super("upload exceeds the background video limit");
  }
}

/** The directory the clip lives in, relative to the project root. */
const SITE_DIR = path.join("public", "uploads", "site");

function siteDir(): string {
  return path.join(process.cwd(), SITE_DIR);
}

/** Delete a stored clip. Missing is success: the file is already gone. */
async function removeFile(relativePath: string | null): Promise<void> {
  if (!relativePath) return;
  try {
    await unlink(path.join(process.cwd(), relativePath));
  } catch {
    // Already gone, or never written. Nothing here depends on the unlink.
  }
}

async function currentVideo(): Promise<BackgroundVideo> {
  return getBackgroundVideo();
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

    // Refused on the declared length so a hostile 40 GB body never reaches the
    // disk, and again by the counter below for a client that lied about it.
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKGROUND_VIDEO_BYTES) {
      return api.error(`That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`, 413, "FILE_TOO_LARGE");
    }

    // And once more from the number the client worked out before it opened the
    // file. It answers a chunked body, which arrives with no Content-Length at
    // all, and it saves reading a byte when the browser already knew.
    const declaredSize = Number(request.headers.get("x-file-size") ?? "");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BACKGROUND_VIDEO_BYTES) {
      return api.error(`That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`, 413, "FILE_TOO_LARGE");
    }

    if (!request.body) {
      return api.validation("The upload was empty — choose a video and try again.");
    }

    const previous = await currentVideo();

    // A fresh token per upload: it is the id of the file on disk and the
    // version in the URL, so replacing the clip is a new address and every
    // browser picks it up without a hard refresh.
    const token = randomBytes(12).toString("hex");
    const fileNameOnDisk = `background-${token}${resolved.extension}`;
    const directory = siteDir();
    const finalPath = path.join(directory, fileNameOnDisk);
    const stagingPath = path.join(directory, `.staging-${token}`);

    let bytes = 0;
    // Typed as the broad Uint8Array: the head is rebuilt from pooled chunks,
    // which are not guaranteed to sit on a plain ArrayBuffer.
    let head: Uint8Array = new Uint8Array(0);
    // Whether the staging copy became the file. The cleanup is a `finally`
    // rather than a line in the `catch` because a REJECTION — an empty body, a
    // file that is not a container we know — returns from inside the `try` and
    // never reaches a catch at all, which is how a staging file used to be left
    // behind on disk for every upload that was refused.
    let stored = false;

    try {
      await mkdir(directory, { recursive: true });
      bytes = await writeToDisk(request.body, stagingPath, (firstBytes) => {
        head = firstBytes;
      });

      if (bytes === 0) {
        return api.validation("That file is empty.");
      }

      // The bytes, not the label. Checked only once the whole file has landed,
      // because a rejection here has to come back as a normal JSON answer rather
      // than as a connection the client's upload had to discover was cut.
      if (!looksLikeBackgroundVideo(head, resolved.extension)) {
        return api.validation(
          "That file is not a video this site can play. Choose an MP4, WebM, MOV or MKV file."
        );
      }

      await rename(stagingPath, finalPath);
      stored = true;
    } catch (error) {
      if (error instanceof UploadTooLarge) {
        return api.error(
          `That video is too large — the limit is ${MAX_BACKGROUND_VIDEO_LABEL}.`,
          413,
          "FILE_TOO_LARGE"
        );
      }
      // Which directory could not be written is for the log: the admin can only
      // be told that it did not stick, and the path is a map of the host.
      console.error("[Background Video] could not persist the upload", error);
      return api.error(
        "This server cannot store a video right now. Try again, or ask support.",
        503,
        "STORAGE_NOT_CONFIGURED"
      );
    } finally {
      // After a successful rename the staging name no longer exists, so this
      // unlink fails and is ignored — the cost of keeping every other path to
      // one line instead of one per return.
      if (!stored) await unlink(stagingPath).catch(() => {});
    }

    const backgroundVideo: BackgroundVideo = {
      active: true,
      token,
      mimeType: resolved.mimeType,
      name: (fileName || fileNameOnDisk).slice(0, 200),
      size: bytes,
    };

    try {
      await setSetting(
        PLATFORM_SETTING_KEYS.backgroundVideo,
        JSON.stringify(backgroundVideo),
        auth.userId
      );
    } catch (error) {
      // The file is on disk but no row points at it: remove it, or it is an
      // orphan nothing will ever serve or clean up.
      await removeFile(backgroundVideoRelativePath(backgroundVideo));
      console.error("[Background Video] could not save the setting", error);
      return api.internal("could not persist the background video setting");
    }

    // The old clip goes only once the new one is recorded. Deleting first would
    // leave the site with no backdrop at all if the write below failed.
    if (previous?.active) {
      await removeFile(backgroundVideoRelativePath(previous));
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
        size: bytes,
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

    // The row goes first. The file is unreferenced the moment the row is gone,
    // so an interrupted delete leaves an orphan on disk rather than a page
    // pointing at a file that is no longer there.
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

    await removeFile(backgroundVideoRelativePath(previous));

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

/**
 * Pipe the request body to a file, counting as it goes.
 *
 * The counter is a Transform in the middle of the pipeline rather than a check
 * afterwards: `pipeline` destroys every stream the moment it errors, so passing
 * the ceiling stops the read, stops the write and leaves only a partial file
 * behind for the caller to unlink — and it never buffers more than one chunk.
 *
 * `onHead` receives the first 16 bytes once, for the container check.
 */
async function writeToDisk(
  body: ReadableStream<Uint8Array>,
  destination: string,
  onHead: (head: Uint8Array) => void
): Promise<number> {
  const source = Readable.fromWeb(
    body as unknown as import("node:stream/web").ReadableStream<Uint8Array>
  );
  const sink = createWriteStream(destination);

  let bytes = 0;
  const headChunks: Uint8Array[] = [];
  let headLength = 0;

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_BACKGROUND_VIDEO_BYTES) {
        callback(new UploadTooLarge());
        return;
      }
      if (headLength < 16) {
        const take = Math.min(16 - headLength, chunk.length);
        headChunks.push(chunk.subarray(0, take));
        headLength += take;
        if (headLength >= 16) onHead(Uint8Array.from(Buffer.concat(headChunks as Buffer[])));
      }
      callback(null, chunk);
    },
  });

  // The head may be shorter than 16 bytes for a tiny file; hand over what there
  // is either way so a small-but-real clip still passes the container check.
  try {
    await pipeline(source, counter, sink);
  } finally {
    if (headLength < 16) onHead(Uint8Array.from(Buffer.concat(headChunks as Buffer[])));
  }

  return bytes;
}
