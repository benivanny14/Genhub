"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipForward,
  Settings,
  Download,
  Loader2,
  Check,
  AlertTriangle,
} from "lucide-react";
import { formatDuration } from "@/lib/utils";
import {
  buildQualityMenu,
  qualityLabelFor,
  type QualityOption,
} from "@/lib/quality";

interface VideoPlayerProps {
  src: string; // HLS stream URL
  poster?: string;
  title: string;
  videoId?: string;
  viewerId?: string;
  isTeaser?: boolean;
  startAt?: number;
  onEnded?: () => void;
  /** Members only: resolves a signed download URL and saves the file */
  onDownload?: () => void;
  downloading?: boolean;
  /**
   * WebVTT captions for this scene, when the creator attached them.
   *
   * Rendered as a <track> on the video element rather than fed through hls.js:
   * a side-loaded caption file is not part of the HLS manifest, and hls.js's
   * subtitleTrack only drives in-manifest WebVTT. A <track> is handled by the
   * browser's own text-track machinery, which works with any source.
   */
  captionsUrl?: string | null;
}

export default function VideoPlayer({
  src,
  poster,
  title,
  videoId,
  viewerId = "anonymous",
  isTeaser = false,
  startAt = 0,
  onEnded,
  onDownload,
  downloading = false,
  captionsUrl,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // The frame takes the PICTURE's shape, not the other way round.
  //
  // The player used to sit in a fixed 16:9 box with the video stretched across
  // it. Anything that was not shot in 16:9 — a phone-shot vertical clip, a 4:3
  // scene — was then either cropped to fill (zooming in, hiding part of the
  // frame and softening the image) or letterboxed inside the box (black bars
  // down the sides). Both were wrong, and both were the reported complaint.
  //
  // Instead, once the browser reports the video's real dimensions
  // (videoWidth / videoHeight on loadedmetadata) the FRAME adopts that aspect
  // ratio and the video fills it exactly with object-fit: contain. Nothing is
  // cropped, nothing is scaled above its natural size, and there are no bars —
  // the page shows a frame that is as wide (or as tall) as the clip really is,
  // capped so a tall clip still fits the viewport.
  const [aspect, setAspect] = useState<number | null>(null);

  // Quality selector state (HLS levels)
  const hlsRef = useRef<Hls | null>(null);
  // Labelled and ordered by lib/quality: hls.js reports PIXEL dimensions and
  // sorts its levels ascending by bitrate, so the raw array offered a portrait
  // upload as "640p" and "352p" with the worst rendition at the top.
  const [levels, setLevels] = useState<QualityOption[]>([]);
  const [selectedLevel, setSelectedLevel] = useState(-1); // -1 = Auto
  const [activeLevel, setActiveLevel] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);

  // ===========================================================================
  // Failure is a state, not a spinner
  // ===========================================================================
  // The player used to load forever when the CDN refused the stream: hls.js
  // reported a fatal error, the handler called startLoad() again, and the only
  // thing the viewer saw was a spinning circle with no reason and no end. A 403
  // on the manifest is exactly this case (Bunny rejecting an unsigned URL — see
  // probeSignedPlayback), and it is not retryable: the same request will always
  // fail. So the viewer is told what happened, and a retry button is offered for
  // the failures that ARE transient (a dropped connection, a stale token).
  const [fatalError, setFatalError] = useState<string | null>(null);
  /** Bumped by the retry button — re-runs the source-loading effect. */
  const [attempt, setAttempt] = useState(0);
  const networkRetries = useRef(0);

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumedRef = useRef(false);

  // =============================================================================
  // Resume playback from a saved position
  // =============================================================================

  useEffect(() => {
    resumedRef.current = false;
    // A new source has its own dimensions; drop the old shape until the new
    // metadata arrives so the frame never keeps the previous clip's ratio.
    setAspect(null);
  }, [src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !startAt || startAt < 2) return;

    const seekToSaved = () => {
      if (resumedRef.current) return;
      if (Number.isFinite(v.duration) && startAt > v.duration - 3) return;
      try {
        v.currentTime = startAt;
        resumedRef.current = true;
      } catch {
        // Metadata not ready — the event will fire again
      }
    };

    v.addEventListener("loadedmetadata", seekToSaved);
    // In case metadata already loaded
    if (v.readyState >= 1) seekToSaved();

    return () => v.removeEventListener("loadedmetadata", seekToSaved);
  }, [startAt]);

  // =============================================================================
  // Initialize HLS Player
  // =============================================================================

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // A manifest that never arrives is the silent-failure case. Bunny answers in
    // well under a second, so 20s of nothing means something is wrong (offline,
    // blocked, a token the CDN will never accept) and the viewer deserves to
    // hear it instead of watching a spinner.
    const watchdog = setTimeout(() => {
      setFatalError((current) =>
        current ||
        "The stream did not start. Check your connection, then try again."
      );
      setIsLoading(false);
    }, 20_000);

    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1, // Auto quality
        // NOTE: do NOT set xhr.withCredentials here. CDNs (mux test streams,
        // Bunny's b-cdn) answer Access-Control-Allow-Origin: "*", and
        // browsers reject wildcard+credentials combos — the manifest would
        // fail CORS and no video would ever play. Bunny signed URLs
        // authenticate via the token query string, not cookies.
      });

      hls.loadSource(src);
      hls.attachMedia(video);

      hlsRef.current = hls;

      networkRetries.current = 0;

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        clearTimeout(watchdog);
        setFatalError(null);
        // Every rendition the CDN offers (1080p / 720p / 480p / 360p …), named
        // the way viewers read them and listed best first. The level COUNT is
        // still the manifest's, so the menu appears exactly when there is
        // something to switch between.
        setLevels(buildQualityMenu(data?.levels || []));
        setIsLoading(false);
        video.play().catch(() => {
          // Autoplay blocked - show play button
        });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setActiveLevel(data.level);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        console.error("[HLS Error]", data);

        const response = (data as { response?: { code?: number; text?: string } }).response;
        const httpStatus = response?.code;

        // Our own stream route answers with a reason in the body when the video
        // host refuses the stream or cannot be reached — and that reason (which
        // variable is wrong, which host answered what) is exactly what the
        // viewer needs to read back to whoever runs the deployment. Passing the
        // raw status on would throw it away and leave "HTTP 502".
        const reasonFromServer = (() => {
          if (!response?.text) return null;
          try {
            const parsed = JSON.parse(response.text) as { error?: unknown };
            return typeof parsed?.error === "string" ? parsed.error : null;
          } catch {
            return null;
          }
        })();

        // 401/403 is the CDN refusing the URL itself. Retrying sends the same
        // rejected request, so say so instead of looping.
        if (httpStatus === 401 || httpStatus === 403) {
          clearTimeout(watchdog);
          setIsLoading(false);
          setFatalError(
            `This video was refused by the video host (HTTP ${httpStatus}). ` +
              "It is a server-side fault, not your connection — the team has been told."
          );
          return;
        }

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              networkRetries.current += 1;
              if (networkRetries.current <= 3) {
                hls?.startLoad();
              } else {
                clearTimeout(watchdog);
                setIsLoading(false);
                setFatalError(
                  reasonFromServer ??
                    (httpStatus
                      ? `The stream could not be loaded (HTTP ${httpStatus}).`
                      : "The stream could not be loaded after several attempts.")
                );
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              // One recovery attempt; a second failure is a broken encode.
              if (networkRetries.current++ === 0) {
                hls?.recoverMediaError();
              } else {
                clearTimeout(watchdog);
                setIsLoading(false);
                setFatalError("This video could not be decoded. Try again later.");
              }
              break;
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        clearTimeout(watchdog);
        setFatalError(null);
        setIsLoading(false);
        video.play().catch(() => {});
      });
      video.addEventListener("error", () => {
        clearTimeout(watchdog);
        setIsLoading(false);
        setFatalError("This video could not be loaded by your browser.");
      });
    }

    return () => {
      clearTimeout(watchdog);
      hls?.destroy();
      hlsRef.current = null;
    };
  }, [src, attempt]);

  // =============================================================================
  // Quality selector
  // =============================================================================

  const chooseQuality = (index: number) => {
    setSelectedLevel(index);
    if (hlsRef.current) {
      // -1 lets hls.js pick the best level for the current bandwidth
      hlsRef.current.currentLevel = index;
    }
    setShowQuality(false);
  };

  // "Auto" names the rendition ABR is on right now, the way every other player
  // shows it — the tier next to Auto is not a promise, it is what is playing.
  const activeLabel = (() => {
    if (selectedLevel !== -1) {
      return qualityLabelFor(levels, selectedLevel) ?? "Auto";
    }
    const playing = qualityLabelFor(levels, activeLevel);
    return playing ? `Auto (${playing})` : "Auto";
  })();

  // =============================================================================
  // Watch Progress — feeds Continue Watching / resume
  // =============================================================================

  useEffect(() => {
    if (!videoId || !viewerId || viewerId === "anonymous" || isTeaser) return;

    const interval = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused || !Number.isFinite(v.duration) || v.duration <= 0) return;
      fetch(`/api/videos/${videoId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionSeconds: Math.floor(v.currentTime),
          duration: Math.floor(v.duration),
        }),
      }).catch(() => {
        // Progress is best-effort — never interrupt playback
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [videoId, viewerId, isTeaser]);

  // =============================================================================
  // No overlay on the picture
  // =============================================================================
  // A moving watermark used to print the viewer's masked phone (or their display
  // name) across the screen every few seconds. Two reasons it is gone:
  //
  //   * It is read as the creator's own contact details floating on the video,
  //     which makes a paid scene look defaced rather than produced. The picture
  //     is the product, so it is shown clean.
  //   * It never actually protected anything — the stream URL is short-lived and
  //     signed, and the leak it was meant to trace could be re-encoded in a way
  //     that drops the overlay entirely.
  //
  // The anti-piracy work that holds is still here: signed, expiring URLs, the
  // disabled right-click and drag below, and the server-side access checks.

  // =============================================================================
  // Anti-Piracy: Prevent right-click, drag, and keyboard shortcuts
  // =============================================================================

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const preventDefault = (e: Event) => e.preventDefault();

    container.addEventListener("contextmenu", preventDefault);
    container.addEventListener("dragstart", preventDefault);

    const handleKeyDown = (e: KeyboardEvent) => {
      // Block common screenshot/recording shortcuts
      if (
        e.key === "PrintScreen" ||
        (e.metaKey && e.shiftKey && (e.key === "3" || e.key === "4" || e.key === "5")) ||
        (e.metaKey && e.key === "s") ||
        (e.ctrlKey && e.key === "s")
      ) {
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("contextmenu", preventDefault);
      container.removeEventListener("dragstart", preventDefault);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // =============================================================================
  // Controls Auto-hide
  // =============================================================================

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      // Never hide the bar while the quality menu is open
      if (isPlaying && !showQuality) setShowControls(false);
    }, 3000);
  }, [isPlaying, showQuality]);

  // Opening the menu pins the control bar so the options stay reachable
  useEffect(() => {
    if (!showQuality) return;
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
  }, [showQuality]);

  // =============================================================================
  // Player Controls
  // =============================================================================

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(!isMuted);
  };

  // The browser's own fullscreen (Esc, the OS control) changes the state behind
  // our back. Without this the frame would think it is still inline after an
  // Esc and clamp itself to the viewport-height cap.
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      await container.requestFullscreen();
      setIsFullscreen(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const time = parseFloat(e.target.value);
    video.currentTime = time;
    setCurrentTime(time);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const vol = parseFloat(e.target.value);
    video.volume = vol;
    setVolume(vol);
    setIsMuted(vol === 0);
  };

  const skip = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
  };

  // One size for every control, so a tap lands the same way on each: 36px on a
  // phone and 40px from `sm` up. The old `p-1.5` around a 20px icon made a ~32px
  // target, and the ones at the right-hand edge — fullscreen especially — were
  // the easiest to miss. `shrink-0` keeps them from being squeezed off the bar
  // on a narrow screen instead of only moved inward.
  const ctrlBtn =
    "h-9 w-9 sm:h-10 sm:w-10 flex items-center justify-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/20 transition touch-manipulation shrink-0";

  return (
    <div
      ref={containerRef}
      className="relative w-full bg-black rounded-2xl overflow-hidden group select-none mx-auto"
      style={
        isFullscreen
          ? { width: "100%", height: "100%" }
          : aspect
            ? // The video's own ratio, at most the full width, and never taller
              // than the viewport — so a vertical clip fits a phone screen nicely
              // and a wide one uses the whole width without being blown up.
              { aspectRatio: `${aspect}`, width: `min(100%, calc(80vh * ${aspect}))` }
            : { aspectRatio: "16 / 9", width: "100%" }
      }
      onMouseMove={showControlsTemporarily}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element.

          The frame's 16:9 lives on the container and the video is stretched
          across it, so there is no letterbox to show: object-cover fills the
          frame (cropping the overflow) and object-contain is the viewer's
          choice when they want the whole frame. `absolute inset-0 h-full w-full`
          is what makes the video follow the container instead of the container
          following the video — the other way round is exactly how the black
          bars came back. */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-contain"
        poster={poster}
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={onEnded}
      >
        {/*
          Captions are NOT default-on. Turning them on by default puts text over
          every scene for viewers who never asked for it, and on a platform like
          this the picture is the product. The browser's own CC button in the
          controls turns them on, and a creator who wants them burned on can
          attach a file and say so in the description.

          `key` on the src: changing the URL must reload the track. A <track>
          whose src changes without remounting keeps the old cue list.
        */}
        {captionsUrl ? (
          <track
            key={captionsUrl}
            kind="captions"
            src={captionsUrl}
            srcLang="sw"
            label="Captions (Kiswahili)"
          />
        ) : null}
      </video>

      {/* Loading State */}
      {isLoading && !fatalError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="w-12 h-12 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Failure State — an explanation and a way out, never a spinner forever */}
      {fatalError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
          <AlertTriangle className="w-9 h-9 text-amber-400" />
          <p className="text-sm text-white/90 max-w-sm">{fatalError}</p>
          <button
            type="button"
            onClick={() => {
              setFatalError(null);
              setIsLoading(true);
              networkRetries.current = 0;
              setAttempt((n) => n + 1);
            }}
            className="rounded-full bg-brand-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 transition"
          >
            Try again
          </button>
        </div>
      )}

      {/* Teaser Label */}
      {isTeaser && (
        <div className="absolute top-4 left-4 bg-brand-500 text-white text-xs font-bold px-3 py-1 rounded-full">
          PREVIEW — {formatDuration(0)} - {formatDuration(15)}
        </div>
      )}

      {/* Big Play Button (when paused) */}
      {!isPlaying && !isLoading && !fatalError && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
        >
          <div className="w-20 h-20 rounded-full bg-brand-500/80 backdrop-blur-sm flex items-center justify-center shadow-2xl shadow-brand-500/40 hover:scale-110 transition-transform">
            <Play className="w-8 h-8 text-white fill-white ml-1" />
          </div>
        </button>
      )}

      {/* Controls Bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* Progress Bar — a slightly taller track on a phone, where a 1px line
            is hard to grab. */}
        <div className="px-2 sm:px-4 pt-2 pb-1">
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek"
            className="w-full h-1.5 sm:h-1 bg-white/20 rounded-full appearance-none cursor-pointer touch-manipulation
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 sm:[&::-webkit-slider-thumb]:w-3 sm:[&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500
              [&::-webkit-slider-thumb]:hover:scale-125 [&::-webkit-slider-thumb]:transition-transform"
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between gap-1 sm:gap-2 px-1.5 sm:px-4 py-1.5 sm:py-2">
          <div className="flex items-center gap-0.5 sm:gap-1 min-w-0">
            <button
              onClick={togglePlay}
              aria-label={isPlaying ? "Pause" : "Play"}
              className={ctrlBtn}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <button
              onClick={() => skip(10)}
              aria-label="Skip forward 10 seconds"
              className={ctrlBtn}
            >
              <SkipForward className="w-5 h-5" />
            </button>
            <button
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className={ctrlBtn}
            >
              {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            {/* The volume slider needs horizontal room the bar does not have on
                a phone, where the mute button above is the control that matters. */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              aria-label="Volume"
              className="hidden sm:block w-16 lg:w-20 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
            <span className="text-[11px] sm:text-xs text-white/70 font-mono ml-1 sm:ml-2 whitespace-nowrap shrink-0">
              {formatDuration(Math.floor(currentTime))}
              <span className="hidden sm:inline"> / {formatDuration(Math.floor(duration))}</span>
            </span>
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
            {/* Members-only download */}
            {onDownload && (
              <button
                onClick={onDownload}
                disabled={downloading}
                aria-label="Download (members)"
                title="Download (members)"
                className={`${ctrlBtn} disabled:opacity-50`}
              >
                {downloading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Download className="w-5 h-5" />
                )}
              </button>
            )}

            {/* Quality selector — only when the stream offers more than one level */}
            {levels.length > 1 && (
              <div className="relative">
                <button
                  onClick={() => setShowQuality((v) => !v)}
                  aria-label="Quality"
                  title="Quality"
                  className={ctrlBtn}
                >
                  <Settings className="w-5 h-5" />
                  {/* The label is the first thing to go on a narrow screen: the
                      gear still opens the menu, and the menu names the level. */}
                  <span className="text-[10px] text-white/70 font-medium hidden lg:inline">
                    {activeLabel}
                  </span>
                </button>

                {showQuality && (
                  <div className="absolute bottom-12 right-0 bg-black/95 backdrop-blur border border-white/10 rounded-xl py-1 min-w-[140px] z-20 shadow-xl">
                    <button
                      onClick={() => chooseQuality(-1)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-white/10 transition"
                    >
                      <span>Auto</span>
                      {selectedLevel === -1 && <Check className="w-3.5 h-3.5 text-brand-400" />}
                    </button>
                    {levels.map((level) => (
                      <button
                        key={level.index}
                        onClick={() => chooseQuality(level.index)}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-white/10 transition"
                      >
                        <span>{level.label}</span>
                        {selectedLevel === level.index && (
                          <Check className="w-3.5 h-3.5 text-brand-400" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className={`${ctrlBtn} mr-0.5 sm:mr-0`}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
