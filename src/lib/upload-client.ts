// =============================================================================
// GENHUB - Client-side image upload helper
// Shared by the KYC form and the creator thumbnail picker: posts the file to
// /api/upload and resolves with the hosted URL (local /uploads/... in dev,
// Bunny CDN URL in production).
// =============================================================================

export class UploadError extends Error {}

export async function uploadImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new UploadError("Please choose an image file");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new UploadError("Image is too large (max 5 MB)");
  }

  const form = new FormData();
  form.append("file", file);

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
