// =============================================================================
// GENHUB - How long is this file? (read locally, never uploaded to find out)
//
// NOT A GATE. This module was written to enforce an eight-minute minimum before
// an upload started; that rule is gone (a scene of any length uploads, and
// nothing takes a published video down for being short — the recommendation
// lives on the guidelines screen). What is left is a genuinely useful, tested
// utility: the duration of a LOCAL file, read from its own metadata with no
// upload, no request and no server round trip, with `null` meaning "this engine
// cannot say" rather than "zero".
//
// The paragraph below is kept because it is the reason the probe is written the
// careful way it is — it explains what a browser can and cannot measure, which
// is not something a caller should have to rediscover.
//
// That was survivable while an unfinished video stayed unpublished: the
// offending scene simply never appeared. Now that a post is published the
// moment it is uploaded (see /api/videos POST), a two-minute clip would go
// LIVE and then be taken down once the length was known — a public post
// appearing and disappearing, over something we could have said in the file
// picker.
//
// So the browser is asked first. This reads the file's own metadata, which is
// a local operation: no upload, no request, no server round trip. It is
// best-effort by design — a container the browser cannot parse (or an iOS
// answer of Infinity) returns null and the upload proceeds, because refusing
// a good file is a worse failure than the server-side backstop catching it.
// =============================================================================

/**
 * The duration of a local file in seconds, or null when the browser cannot say.
 *
 * `null` is a real answer, not an error: callers must treat it as "asked and
 * not told" and let the file through. The element and the object URL are both
 * released on every path, including the timeout — a leaked object URL holds
 * the whole file in memory for the life of the page, which on a 2 GB upload is
 * not a small leak.
 */
export function probeVideoDuration(file: File, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
      resolve(null);
      return;
    }

    let settled = false;
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);

    const finish = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // Detach first, then release: a video element still holding a revoked
      // URL can log a media error on some browsers.
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // Some engines throw when load() follows a detached src; harmless.
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Nothing to do — the page is going away with it.
      }
      resolve(seconds);
    };

    const timer = window.setTimeout(() => finish(null), timeoutMs);

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const seconds = video.duration;
      // `Infinity` is what several mobile browsers report for a fragmented MP4
      // before any seek; `NaN` shows up for a container the engine half-parsed.
      // Neither is a length, so both are "cannot say".
      finish(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    video.onerror = () => finish(null);
    video.src = objectUrl;
  });
}

/**
 * A creator-facing refusal for a file that is definitely too short, or null.
 *
 * Split out from the probe so the wording lives beside the rule it enforces and
 * can be unit-tested without a DOM.
 */
export function shortVideoError(
  seconds: number | null,
  minimumSeconds: number
): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= minimumSeconds) return null;

  const minutes = minimumSeconds / 60;
  const readLength =
    seconds < 60
      ? `${Math.round(seconds)} second(s)`
      : `${(seconds / 60).toFixed(1)} minute(s)`;

  return (
    `That video is ${readLength} long, and every scene must be at least ` +
    `${minutes} minutes. Trim it, or choose a longer version — a shorter video ` +
    `would be taken down after it went live.`
  );
}
