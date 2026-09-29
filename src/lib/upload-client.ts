// =============================================================================
// GENHUB - Client-side image and caption uploads
// Video uploads use lib/video-upload.ts and Bunny Stream TUS. This helper is
// deliberately limited to small files that must pass through /api/upload.
// =============================================================================

import { downscaleImage } from "./image-downscale";

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

export async function uploadImage(file: File, options: UploadOptions = {}): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new UploadError("Please choose an image file");
  }

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
