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

export class UploadError extends Error {}

export interface UploadOptions {
  /** "public" (default) — anyone can read it. "private" — owner and admins. */
  kind?: "public" | "private";
}

export async function uploadImage(file: File, options: UploadOptions = {}): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new UploadError("Please choose an image file");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new UploadError("Image is too large (max 5 MB)");
  }

  const form = new FormData();
  form.append("file", file);
  form.append("kind", options.kind ?? "public");

  let res: Response;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form });
  } catch {
    throw new UploadError("Network error — image was not uploaded");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new UploadError(data?.error || "Image upload failed");
  }
  return data.data.url as string;
}
