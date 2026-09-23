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
} from "lucide-react";
import { formatDuration } from "@/lib/utils";

interface VideoPlayerProps {
  src: string; // HLS stream URL
  poster?: string;
  title: string;
  videoId?: string;
  viewerId?: string;
  viewerPhone?: string;
  /** Display name shown on the anti-leak watermark instead of "Viewer <id>" */
  viewerName?: string;
  isTeaser?: boolean;
  startAt?: number;
  onEnded?: () => void;
  /** Members only: resolves a signed download URL and saves the file */
  onDownload?: () => void;
  downloading?: boolean;
}

export default function VideoPlayer({
  src,
  poster,
  title,
  videoId,
  viewerId = "anonymous",
  viewerPhone,
  viewerName,
  isTeaser = false,
  startAt = 0,
  onEnded,
  onDownload,
  downloading = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const watermarkIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // Quality selector state (HLS levels)
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<{ index: number; label: string }[]>([]);
  const [selectedLevel, setSelectedLevel] = useState(-1); // -1 = Auto
  const [activeLevel, setActiveLevel] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumedRef = useRef(false);

  // =============================================================================
  // Resume playback from a saved position
  // =============================================================================

  useEffect(() => {
    resumedRef.current = false;
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

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        // Expose every rendition the CDN offers (1080p / 720p / 480p / 360p …)
        setLevels(
          (data?.levels || []).map((level, index) => ({
            index,
            label: level.height ? `${level.height}p` : `Level ${index + 1}`,
          }))
        );
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
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError();
              break;
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        setIsLoading(false);
        video.play().catch(() => {});
      });
    }

    return () => {
      hls?.destroy();
      hlsRef.current = null;
    };
  }, [src]);

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

  const activeLabel =
    selectedLevel === -1
      ? activeLevel >= 0 && levels[activeLevel]
        ? `Auto (${levels[activeLevel].label})`
        : "Auto"
      : levels[selectedLevel]?.label || "Auto";

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
  // Dynamic Watermark System
  // =============================================================================

  const createWatermark = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const watermark = document.createElement("div");
    watermark.className = "watermark-overlay";

    // Watermark identifies the ACCOUNT: masked phone, else display name,
    // else raw id prefix. The old "Viewer <id>" label mis-reported creators
    // and admins as viewers.
    const text = viewerPhone
      ? viewerPhone.replace(/(\d{3})\d{4}(\d{3})/, "$1****$2")
      : viewerName || viewerId.slice(0, 8);

    watermark.textContent = text;

    // Random position
    const maxX = container.clientWidth - 150;
    const maxY = container.clientHeight - 30;
    watermark.style.left = `${Math.random() * maxX}px`;
    watermark.style.top = `${Math.random() * maxY}px`;

    // Random slight rotation
    watermark.style.transform = `rotate(${(Math.random() - 0.5) * 20}deg)`;

    container.appendChild(watermark);

    // Fade in and out
    watermark.style.opacity = "0";
    watermark.style.transition = "opacity 2s";
    requestAnimationFrame(() => {
      watermark.style.opacity = "1";
    });

    setTimeout(() => {
      watermark.style.opacity = "0";
      setTimeout(() => watermark.remove(), 2000);
    }, 5000);
  }, [viewerId, viewerPhone, viewerName]);

  useEffect(() => {
    if (isTeaser) return; // No watermark for teasers

    // Create watermarks periodically
    watermarkIntervalRef.current = setInterval(createWatermark, 8000);
    createWatermark(); // Create one immediately

    return () => {
      if (watermarkIntervalRef.current) {
        clearInterval(watermarkIntervalRef.current);
      }
    };
  }, [createWatermark, isTeaser]);

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

  return (
    <div
      ref={containerRef}
      className="relative bg-black rounded-2xl overflow-hidden group select-none"
      onMouseMove={showControlsTemporarily}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className="w-full aspect-video"
        poster={poster}
        playsInline
        preload="metadata"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={onEnded}
      />

      {/* Loading State */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="w-12 h-12 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Teaser Label */}
      {isTeaser && (
        <div className="absolute top-4 left-4 bg-brand-500 text-white text-xs font-bold px-3 py-1 rounded-full">
          PREVIEW — {formatDuration(0)} - {formatDuration(15)}
        </div>
      )}

      {/* Big Play Button (when paused) */}
      {!isPlaying && !isLoading && (
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
        {/* Progress Bar */}
        <div className="px-4 pt-2">
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500
              [&::-webkit-slider-thumb]:hover:scale-125 [&::-webkit-slider-thumb]:transition-transform"
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <button onClick={togglePlay} className="p-1.5 hover:bg-white/10 rounded-lg transition">
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <button onClick={() => skip(10)} className="p-1.5 hover:bg-white/10 rounded-lg transition">
              <SkipForward className="w-5 h-5" />
            </button>
            <button onClick={toggleMute} className="p-1.5 hover:bg-white/10 rounded-lg transition">
              {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-20 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
            <span className="text-xs text-white/70 font-mono ml-2">
              {formatDuration(Math.floor(currentTime))} / {formatDuration(Math.floor(duration))}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Members-only download */}
            {onDownload && (
              <button
                onClick={onDownload}
                disabled={downloading}
                title="Download (members)"
                className="p-1.5 hover:bg-white/10 rounded-lg transition disabled:opacity-50"
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
                  title="Quality"
                  className="flex items-center gap-1.5 p-1.5 hover:bg-white/10 rounded-lg transition"
                >
                  <Settings className="w-5 h-5" />
                  <span className="text-[10px] text-white/70 font-medium hidden sm:inline">
                    {activeLabel}
                  </span>
                </button>

                {showQuality && (
                  <div className="absolute bottom-11 right-0 bg-black/95 backdrop-blur border border-white/10 rounded-xl py-1 min-w-[140px] z-20 shadow-xl">
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

            <button onClick={toggleFullscreen} className="p-1.5 hover:bg-white/10 rounded-lg transition">
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
