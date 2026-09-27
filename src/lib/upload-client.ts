// =============================================================================
// GENHUB - Client-side image upload helper
// Shared by the KYC form, the creator thumbnail picker and the profile avatar:
// posts the file to /api/upload and resolves with the in-app URL that serves it
// (`/api/media/...`).
//
// `kind` is required rather than defaulted for the private bucket. Asking a
// caller to write `kind: "private"` for an identity document makes the privacy
// decision visible at the call site; a silent default is how an ID photo ends up
// in the public bucket. Public stays the default because that is what most
// callers are (a thumbnail, an avatar).
// =============================================================================

import { downscaleImage } from "./image-downscale";

export class UploadError extends Error {}

export interface UploadOptions {
  /** "public" (default) — anyone can read it. "private" — owner and admins. */
  kind?: "public" | "private";
}

// A phone photo is routinely 4-8 MB before it is cropped, so the image ceiling
// is 10 MB. Captions are text and stay at 5 MB — see /api/upload for the
// server-side cap, which is what actually enforces this.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTION_BYTES = 5 * 1024 * 1024;

/** One POST, one failure message, shared by every caller in this file. */
async function post(file: File, kind: "public" | "private", what: string): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);

  let res: Response;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form });
  } catch {
    throw new UploadError(`Network error — the ${what} was not uploaded`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new UploadError(data?.error || `The ${what} could not be uploaded`);
  }
  return data.data.url as string;
}

export async function uploadImage(file: File, options: UploadOptions = {}): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new UploadError("Please choose an image file");
  }
  // Shrink a big phone photo here, before it is sent. This is what keeps a
  // normal picture under the hosting platform's request-body cap (4.5 MB on
  // Vercel) and under our own 10 MB limit — and it means what the server
  // receives is already the size it wants.
  const prepared = await downscaleImage(file);

  if (prepared.size > MAX_IMAGE_BYTES) {
    throw new UploadError("Image is too large (max 10 MB)");
  }

  return post(prepared, options.kind ?? "public", "image");
}

/**
 * A WebVTT captions file.
 *
 * Checked by extension rather than MIME type, because the type a browser reports
 * for a .vtt is inconsistent (`text/vtt`, `text/plain`, or empty depending on the
 * OS and how the file was picked) and the server accepts all three. The suffix
 * is what the player requires anyway: a browser handed an .srt shows nothing and
 * logs nothing.
 */
export async function uploadCaptions(file: File): Promise<string> {
  if (!/\.vtt$/i.test(file.name)) {
    throw new UploadError("Captions must be a .vtt (WebVTT) file — .srt will not play");
  }
  if (file.size > MAX_CAPTION_BYTES) {
    throw new UploadError("Captions file is too large (max 5 MB)");
  }

  return post(file, "public", "captions file");
}
