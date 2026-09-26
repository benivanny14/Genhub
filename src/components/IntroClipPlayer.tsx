"use client";

// =============================================================================
// GENHUB - Intro clip player
// =============================================================================
// The moving part of the intro card: the four-segment trailer served by
// /api/videos/[id]/intro-clip, playing silently and on a loop behind the offer.
//
// Three things make this different from VideoPlayer, and all three are on
// purpose:
//
//   - No controls, no seek bar, no quality menu. An intro is not something the
//     viewer operates; it is something they watch until they decide to pay. The
//     only interactive element is the button the page puts over it.
//   - Muted and looping, so autoplay is allowed by every browser and the card
//     keeps moving while the viewer reads the price.
//   - HLS IS LOADED LAZILY. hls.js is ~150KB, and VideoDetail already keeps it
//     out of the initial bundle by importing VideoPlayer dynamically; a static
//     import here would put it straight back on the critical path of the page
//     that is trying to sell something.
//
// A clip that cannot play is not an error to show anyone: `onUnavailable` lets
// the page drop to Bunny's animated preview, and then to the poster. The viewer
// never sees a spinner standing where the intro should be.
// =============================================================================

import { useEffect, useState } from "react";

interface IntroClipPlayerProps {
  /** HLS manifest URL — always our own /api route, never the CDN. */
  src: string;
  /** Shown until the first frame arrives, so the card is never a black hole. */
  poster?: string;
  title: string;
  /** Called once when the clip cannot be played. The caller then falls back. */
  onUnavailable?: () => void;
  /** Called when the clip reaches its end (it loops, so only when looping is off). */
  onEnded?: () => void;
  /** Play once instead of looping — used by the card hover preview. */
  loop?: boolean;
  className?: string;
}

/** A manifest that never arrives must not leave a spinner forever. */
const LOAD_TIMEOUT_MS = 15_000;

export default function IntroClipPlayer({
  src,
  poster,
  title,
  onUnavailable,
  onEnded,
  loop = true,
  className = "",
}: IntroClipPlayerProps) {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!videoEl || failed) return;

    let disposed = false;
    let hls: { destroy: () => void } | null = null;

    const giveUp = () => {
      if (disposed) return;
      clearTimeout(watchdog);
      setFailed(true);
      onUnavailable?.();
    };

    const watchdog = setTimeout(giveUp, LOAD_TIMEOUT_MS);

    // The watchdog is cleared by DATA, not by a parsed manifest. Those are not
    // the same event: the manifest can parse in full and every fragment after it
    // still be refused, and a card that looks like a player but never shows a
    // frame is worse than the poster underneath it.
    const onFirstFrame = () => {
      clearTimeout(watchdog);
      videoEl.play().catch(() => {
        // Autoplay refused (data saver, or a browser policy). The poster and the
        // offer still stand, which is a better answer than an error message.
      });
    };
    videoEl.addEventListener("loadeddata", onFirstFrame, { once: true });

    (async () => {
      try {
        const { default: Hls } = await import("hls.js");
        if (disposed) return;

        if (Hls.isSupported()) {
          const instance = new Hls({
            // A 16 second clip needs no buffer strategy: fetch it and be done,
            // and start on the lowest rendition so the first frame appears fast.
            maxBufferLength: 8,
            maxMaxBufferLength: 16,
            startLevel: 0,
            enableWorker: true,
            // Defaults are six retries with backoff, which is right for a full
            // film and wrong here: an intro that cannot play should hand over to
            // the fallback in a second, not spend half a minute retrying a
            // refusal that will never change.
            manifestLoadingMaxRetry: 1,
            levelLoadingMaxRetry: 1,
            fragLoadingMaxRetry: 1,
            fragLoadingRetryDelay: 400,
          });
          hls = instance;

          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (disposed) return;
            const status = (data as { response?: { code?: number } }).response?.code;
            // A refusal is not a blip: the CDN will answer the same way to the
            // same signed URL forever, so waiting out the retries only delays the
            // fallback. 401/403 is a signature or referrer problem and 404 is a
            // segment that is not there — neither is worth a second attempt.
            const refused = status === 401 || status === 403 || status === 404;
            if (data.fatal || refused) {
              instance.destroy();
              hls = null;
              giveUp();
            }
          });

          instance.loadSource(src);
          instance.attachMedia(videoEl);
        } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
          videoEl.src = src;
        } else {
          giveUp();
        }
      } catch {
        giveUp();
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(watchdog);
      videoEl.removeEventListener("loadeddata", onFirstFrame);
      hls?.destroy();
    };
    // `failed` is a dependency so a fallback that never fires cannot re-run this
    // effect in a loop; `onUnavailable` is read from the closure on purpose, so a
    // caller passing an inline lambda does not restart playback on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, src, failed]);

  useEffect(() => {
    const element = videoEl;
    if (!element || !onEnded) return;
    element.addEventListener("ended", onEnded);
    return () => element.removeEventListener("ended", onEnded);
  }, [videoEl, onEnded]);

  return (
    <video
      ref={setVideoEl}
      // `muted` has to be set as an attribute before the first play attempt, not
      // only through React's property, or Safari refuses the autoplay.
      muted
      autoPlay
      loop={loop}
      playsInline
      preload="auto"
      poster={poster}
      aria-label={`${title} — intro`}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative h-full w-full object-cover ${className}`}
    />
  );
}
