// =============================================================================
// GENHUB - Client-side image and caption uploads
// Video uploads use lib/video-upload.ts and Bunny Stream TUS. This helper is
// deliberately limited to small files that must pass through /api/upload.
// =============================================================================

import { downscaleImage } from "./image-downscale";
import { classifyFile } from "./media";

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadOptions {
  kind?: "public" | "private";
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTION_BYTES = 5 * 1024 * 1024;

async function post(file: File, kind: "public" | "private", what: string): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);

  let response: Response;
  try {
    response = await fetch("/api/upload", { method: "POST", body: form });
  } catch {
    throw new UploadError(`Network error - the ${what} was not uploaded`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success || typeof body.data?.url !== "string") {
    throw new UploadError(body?.error || `The ${what} could not be uploaded`);
  }
  return body.data.url;
}

/**
 * Why this file will not be sent as a picture, or null when it will be.
 *
 * The check used to be `file.type.startsWith("image/")`, which is a claim the
 * browser makes and a phone often does not: a gallery photo or a picture saved
 * by a chat app arrives as `""` or `application/octet-stream`, and a real picture
 * was answered with "Please choose an image file" — the report this exists to
 * stop. classifyFile reads the extension when the MIME says nothing useful
 * (see lib/media), so a `photo.jpg` with no type is a picture and a `clip.mp4`
 * is not, whatever the picker called them.
 *
 * Pure on purpose — no canvas, no network — so the rule is pinned by a test
 * rather than discovered on somebody's phone.
 */
export function imageUploadRefusal(file: {
  name?: string | null;
  type?: string | null;
}): string | null {
  return classifyFile(file) === "image"
    ? null
    : "That file is not a picture — choose an image of any kind " +
      "(JPEG, PNG, HEIC, GIF, AVIF, BMP, TIFF…)";
}

export async function uploadImage(file: File, options: UploadOptions = {}): Promise<string> {
  const refusal = imageUploadRefusal(file);
  if (refusal) throw new UploadError(refusal);

  const prepared = await downscaleImage(file);
  if (prepared.size > MAX_IMAGE_BYTES) {
    throw new UploadError("Image is too large (max 10 MB)");
  }
  return post(prepared, options.kind ?? "public", "image");
}

export async function uploadCaptions(file: File): Promise<string> {
  if (!/\.vtt$/i.test(file.name)) {
    throw new UploadError("Captions must be a .vtt (WebVTT) file - .srt will not play");
  }
  if (file.size > MAX_CAPTION_BYTES) {
    throw new UploadError("Captions file is too large (max 5 MB)");
  }
  return post(file, "public", "captions file");
}
