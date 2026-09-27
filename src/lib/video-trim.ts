// =============================================================================
// GENHUB - Cutting a video down before it is uploaded
// =============================================================================
//
// A creator often films more than the scene: a few seconds of fumbling for the
// record button, a false start, a long tail after the point. Those bytes then
// travel up a Tanzanian mobile connection, get stored in Bunny, and get
// transcoded — all paid for, all published. The trim step happens in the
// BROWSER instead: the creator picks the part worth keeping, watches it, and
// only the kept part is uploaded.
//
// There is no ffmpeg and no server-side media worker in this project, so the
// cut is a real re-encode in the browser: the selected span is played into a
// canvas and re-recorded with MediaRecorder. That is the one technique that
// needs no infrastructure, and it is why the pure arithmetic below lives apart
// from the React component — so the boundary rules can be tested without a
// browser, and so the component only has to drive the media elements.
//
// Everything here is deliberately dependency-free arithmetic.

/** The shortest clip a trim may leave behind, in seconds. */
export const MIN_TRIM_SECONDS = 1;

export interface TrimRange {
  start: number;
  end: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Force a range into something that can actually be recorded.
 *
 * The timeline hands us numbers from pointer positions and from a video whose
 * duration may not be known yet, so they can be NaN, negative, past the end, or
 * reversed. A range that is kept must satisfy `0 <= start <= end <= duration`
 * and keep at least MIN_TRIM_SECONDS — anything else would make MediaRecorder
 * produce an empty or truncated file while looking fine on screen.
 *
 * When the source is shorter than the minimum (a two-second clip cannot lose a
 * second and still be a clip), the whole video is the range.
 */
export function clampTrimRange(range: TrimRange, duration: number): TrimRange {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };

  const minLength = Math.min(MIN_TRIM_SECONDS, duration);
  const start = clamp(
    Number.isFinite(range.start) ? range.start : 0,
    0,
    Math.max(0, duration - minLength)
  );
  let end = clamp(Number.isFinite(range.end) ? range.end : duration, 0, duration);
  if (end < start + minLength) end = start + minLength;
  return { start, end };
}

/** How many seconds the trimmed clip will hold. */
export function trimDuration(range: TrimRange): number {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return 0;
  return Math.max(0, range.end - range.start);
}

export function isFullRange(range: TrimRange, duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    range.start <= 0.05 &&
    range.end >= duration - 0.05
  );
}

/**
 * `m:ss`, or `h:mm:ss` once the clip is longer than an hour.
 *
 * lib/utils `formatDuration` spreads minutes without bound (`90:00`), which is
 * fine for a short player but reads as a broken clock next to a trim slider.
 */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

/**
 * Browser-recordable containers, best first.
 *
 * WebM/VP8 is the widest support for MediaRecorder; VP9 gives a smaller file
 * where it exists. MP4 recording only landed in recent Chromium, so it is the
 * last resort — chosen only when nothing else is offered.
 */
export const TRIM_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

/** The first candidate the browser says it can record, or null. */
export function pickTrimMimeType(
  isSupported: (mime: string) => boolean
): string | null {
  for (const mime of TRIM_MIME_CANDIDATES) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // Some engines throw on an unknown type instead of returning false.
    }
  }
  return null;
}

/** The bare container type to stamp on the produced Blob/File. */
export function baseMimeType(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** The extension the trimmed file should carry, from its container. */
export function extensionForMime(mime: string): string {
  return baseMimeType(mime).includes("mp4") ? "mp4" : "webm";
}

/**
 * A filename for the trimmed file, keeping the creator's own name so it is
 * still recognisable in their files after the download.
 */
export function outputFileName(originalName: string, mime: string): string {
  const base = (originalName || "video").replace(/\.[^./\\]+$/, "") || "video";
  return `${base}-trimmed.${extensionForMime(mime)}`;
}

function toEven(value: number): number {
  const rounded = Math.round(value);
  if (rounded <= 2) return 2;
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * The canvas resolution to record at.
 *
 * Down-scaled to at most `maxWidth` so a 4K phone clip does not re-encode at 4K
 * on a mid-range handset (which is how the recording drops frames and the trim
 * comes out choppy). Dimensions are forced even: H.264 and VP8 both refuse an
 * odd width or height, and the failure is an empty file.
 */
export function exportCanvasSize(
  width: number,
  height: number,
  maxWidth = 1280
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: maxWidth, height: toEven((maxWidth * 9) / 16) };
  }
  if (width <= maxWidth) {
    return { width: toEven(width), height: toEven(height) };
  }
  const scale = maxWidth / width;
  return { width: toEven(maxWidth), height: toEven(height * scale) };
}

/**
 * A recording bitrate that keeps a trimmed clip honest without bloating it.
 * Tuned by output height, because that is what actually drives how many bits a
 * frame needs; a fixed rate either starves 1080p or wastes data on 360p.
 */
export function recordingBitsPerSecond(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 4_000_000;
  if (height >= 1080) return 8_000_000;
  if (height >= 720) return 5_000_000;
  if (height >= 480) return 2_500_000;
  return 1_500_000;
}
