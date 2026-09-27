// =============================================================================
// GENHUB - Shrink a picture in the browser before it is uploaded
// =============================================================================
// A modern phone photo is 3-12 MB and 12 megapixels wide. Uploading it untouched
// is bad for three reasons, and the third is the one that bites:
//
//   1. It is slower on a metered mobile connection, for no visible gain — the
//      picture is displayed at a few hundred pixels.
//   2. It costs Bunny storage and CDN egress for bytes no viewer ever sees.
//   3. On Vercel, a Serverless Function request body is capped at 4.5 MB, so a
//      photo above that is rejected by the platform BEFORE the route runs. No
//      app-level limit can rescue it, because the request never reaches the app.
//
// So the fix is to make the file small HERE, in the browser, where the decode is
// free and the network has not been paid for yet. This is also the only honest
// workaround for the platform cap: Bunny Storage authenticates every request
// with the AccessKey header and offers no presigned/direct browser upload (see
// PRODUCTION.md), so the bytes must pass through our server — and the way to
// keep them under the platform limit is to send fewer of them.
//
// Nothing here is a security control; the server's own caps still apply. It is a
// quality/perf step that happens to keep normal photos inside every limit.
// =============================================================================

export interface DownscaleOptions {
  /** Longest edge, in pixels, kept. Larger pictures are scaled down to fit. */
  maxDimension?: number;
  /** Target ceiling for the encoded file. Kept under Vercel's 4.5 MB body cap. */
  maxBytes?: number;
  /** JPEG quality for the first attempt (0-1). Later attempts step down. */
  quality?: number;
}

const DEFAULTS: Required<DownscaleOptions> = {
  maxDimension: 2048,
  maxBytes: 4 * 1024 * 1024,
  quality: 0.85,
};

/** Formats a canvas can safely re-encode. */
const REENCODABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Decode the file into an <img>, or null when the browser cannot read it. */
function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Draw the image at a size and encode it, or null if the canvas refuses. */
function encode(
  img: HTMLImageElement,
  width: number,
  height: number,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return resolve(null);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // A transparent PNG flattened into a JPEG would turn black. Paint white
    // first so the fallback looks like a photo, not a shadow.
    if (type === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function renamed(blob: Blob, original: File, type: string): File {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = original.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${base}.${ext}`, { type });
}

/**
 * Return a File that is small enough to upload, or the original when it already
 * is (or when it cannot be re-encoded at all).
 *
 * The picture is NEVER enlarged and a file that already fits is returned
 * untouched — re-encoding a good image would only lose quality for nothing.
 */
export async function downscaleImage(
  file: File,
  options: DownscaleOptions = {}
): Promise<File> {
  const { maxDimension, maxBytes, quality } = { ...DEFAULTS, ...options };

  // Browser-only: an SSR pass or a unit test has no canvas.
  if (typeof document === "undefined" || typeof Image === "undefined") return file;
  if (!file.type.startsWith("image/")) return file;
  // An animated GIF or a vector is not a photo; re-encoding one destroys it.
  if (!REENCODABLE.has(file.type)) return file;

  const img = await loadImage(file);
  if (!img || !img.naturalWidth || !img.naturalHeight) return file;

  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;

  // Already small in every sense — leave it exactly as the user chose it.
  if (file.size <= maxBytes && w0 <= maxDimension && h0 <= maxDimension) {
    return file;
  }

  // PNG keeps PNG so transparency survives, falling back to JPEG only when the
  // re-encode still will not fit.
  const types = file.type === "image/png" ? ["image/png", "image/jpeg"] : ["image/jpeg"];

  let scale = Math.min(1, maxDimension / Math.max(w0, h0));
  let smallest: { blob: Blob; type: string } | null = null;

  // A few passes: shrink, and step the quality down, until the file fits.
  for (let attempt = 0; attempt < 5; attempt++) {
    const width = Math.max(1, Math.round(w0 * scale));
    const height = Math.max(1, Math.round(h0 * scale));
    for (const type of types) {
      const q = type === "image/png" ? 1 : Math.max(0.45, quality - attempt * 0.1);
      const blob = await encode(img, width, height, type, q);
      if (!blob) continue;
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, type };
      if (blob.size <= maxBytes) return renamed(blob, file, type);
    }
    scale *= 0.75;
  }

  // Could not reach the target — hand over the best attempt. The server's own
  // size check is still the backstop, and a smaller file beats the original.
  return smallest && smallest.blob.size < file.size
    ? renamed(smallest.blob, file, smallest.type)
    : file;
}
