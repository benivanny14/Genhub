"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { Play, Clock, Eye, Heart, Bookmark, BadgeCheck, Lock } from "lucide-react";
import { formatTZS, formatDuration } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

interface VideoCardProps {
  id: string;
  title: string;
  slug?: string | null;
  thumbnailUrl?: string | null;
  teaserUrl?: string | null;
  /**
   * The scene's stitched intro clip (`/api/videos/<id>/intro-clip`), sent for a
   * paid scene with no trailer of its own. Hovering a card is the moment a
   * viewer decides, so a locked card must move like every other card on the
   * grid — it is the same sixteen seconds the watch page shows before the
   * paywall.
   */
  introUrl?: string | null;
  price: number;
  duration?: number | null;
  viewsCount: number;
  teaserDuration: number;
  likesCount?: number;
  isPremium?: boolean;
  creator: {
    id: string;
    displayName: string | null;
    avatarUrl?: string | null;
    isVerified?: boolean;
  };
  createdAt: string;
}

export default function VideoCard(video: VideoCardProps) {
  const displaySlug = video.slug || video.id;
  const { theme } = useTheme();
  const { toast } = useToast();
  const isLight = theme === "light";
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewHlsRef = useRef<{ destroy: () => void } | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewActiveRef = useRef(false);

  // The creator's own trailer when there is one; otherwise the clip cut from
  // the scene, so a PAID card previews like any other card instead of sitting
  // there as a still. Both are HLS manifests our own routes serve, so the card
  // never talks to the CDN directly.
  const previewSrc = video.teaserUrl || video.introUrl || null;

  // Hover preview — lazily load hls.js only when the user actually hovers
  function startPreview() {
    if (!previewSrc || previewActiveRef.current) return;
    if (typeof window === "undefined" || !window.matchMedia("(hover: hover)").matches) return;
    previewActiveRef.current = true;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      const el = previewVideoRef.current;
      if (!el || !previewActiveRef.current || !previewSrc) return;
      try {
        const { default: Hls } = await import("hls.js");
        if (!previewActiveRef.current) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ maxBufferLength: 4, maxMaxBufferLength: 8, startLevel: 0 });
          hls.loadSource(previewSrc);
          hls.attachMedia(el);
          previewHlsRef.current = hls;
        } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
          el.src = previewSrc;
        } else {
          return;
        }
        await el.play();
        if (previewActiveRef.current) setPreviewing(true);
      } catch {
        // Stream unavailable — card just stays a static thumbnail
        stopPreview();
      }
    }, 450);
  }

  function stopPreview() {
    previewActiveRef.current = false;
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    const el = previewVideoRef.current;
    if (el) {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {}
    }
    if (previewHlsRef.current) {
      try {
        previewHlsRef.current.destroy();
      } catch {}
      previewHlsRef.current = null;
    }
    setPreviewing(false);
  }

  useEffect(() => () => stopPreview(), []);

  /**
   * The heart fills, AND the write is checked.
   *
   * This used to fire the request and ignore the answer, so a signed-out tap —
   * or any failure — left a filled heart behind with nothing saved. From the
   * viewer's side that is exactly "the like button does not work": it lights up,
   * and a reload loses it. Now the heart is put back whenever the write did not
   * succeed, and a signed-out tap says why instead of pretending.
   */
  async function handleLike(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !liked;
    setLiked(next);
    try {
      const res = await fetch(`/api/videos/${video.id}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "like" }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.success) {
        setLiked(!next);
        if (res.status === 401 || res.status === 403) {
          toast("warning", "Sign in to like this video");
        } else {
          toast("error", data?.error || "Could not save your like");
        }
      }
    } catch {
      setLiked(!next);
      toast("error", "Could not save your like");
    }
  }

  async function handleSave(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !saved;
    setSaved(next);
    try {
      const res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.success) {
        setSaved(!next);
        toast(
          res.status === 401 || res.status === 403 ? "warning" : "error",
          res.status === 401 || res.status === 403
            ? "Sign in to save this video"
            : data?.error || "Could not save this video"
        );
      }
    } catch {
      setSaved(!next);
      toast("error", "Could not save this video");
    }
  }

  return (
    <div className="video-card group">
      {/* Thumbnail */}
      <Link
        href={`/video/${displaySlug}`}
        className="relative block aspect-video overflow-hidden"
        onMouseEnter={startPreview}
        onMouseLeave={stopPreview}
        aria-label={video.title}
      >
        {/* Hover preview video */}
        <video
          ref={previewVideoRef}
          muted
          loop
          playsInline
          preload="none"
          className={`absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-300 ${
            previewing ? "opacity-100" : "opacity-0"
          }`}
        />
        {video.thumbnailUrl ? (
          <Image
            src={video.thumbnailUrl}
            alt={video.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          />
        ) : (
          <div className={cn(
            "w-full h-full flex items-center justify-center",
            isLight ? "bg-gray-100" : "bg-gradient-to-br from-surface-300 to-surface-400"
          )}>
            <Play className={cn("w-12 h-12", isLight ? "text-gray-300" : "text-white/20")} />
          </div>
        )}

        {/* Play Button Overlay — and out of the way of a running preview */}
        <div
          className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
            previewing ? "opacity-0" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <div className="w-14 h-14 rounded-full bg-brand-500/80 backdrop-blur-sm flex items-center justify-center shadow-lg shadow-brand-500/30">
            <Play className="w-6 h-6 text-white fill-white ml-0.5" />
          </div>
        </div>

        {/* Preview indicator */}
        {previewing && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded-full text-[10px] font-medium text-white/90 pointer-events-none z-10">
            ▶ Preview
          </div>
        )}

        {/* Duration Badge */}
        {video.duration && (
          <div className="absolute bottom-2 right-2 bg-black/70 backdrop-blur-sm px-2 py-0.5 rounded text-xs font-medium text-white">
            {formatDuration(video.duration)}
          </div>
        )}

        {/* Price Badge */}
        <div className="absolute top-2 left-2 bg-brand-500 text-white px-2.5 py-1 rounded-lg text-xs font-bold shadow-lg">
          TZS {video.price.toLocaleString()}
        </div>

        {/* Premium Lock Icon */}
        {video.isPremium && (
          <div className="absolute top-2 right-12 bg-red-500/80 backdrop-blur-sm p-1 rounded-full">
            <Lock className="w-3 h-3 text-white" />
          </div>
        )}

        {/* Preview Duration */}
        <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded text-xs text-white/80 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {video.teaserDuration}s
        </div>

        {/* Premium content restriction watermark */}
        {video.isPremium && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 -rotate-[24deg] scale-125 opacity-[0.15]">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-6 whitespace-nowrap text-white font-bold text-[10px] tracking-[0.25em] uppercase">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <span key={j}>Genhub • 18+ • Premium</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Like + Save buttons */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={handleLike}
            className={cn(
              "p-1.5 rounded-full backdrop-blur-sm transition-colors",
              liked
                ? "bg-red-500/90 text-white"
                : "bg-black/50 text-white/80 hover:bg-red-500/80 hover:text-white"
            )}
          >
            <Heart className={cn("w-3.5 h-3.5", liked && "fill-white")} />
          </button>
          <button
            onClick={handleSave}
            className={cn(
              "p-1.5 rounded-full backdrop-blur-sm transition-colors",
              saved
                ? "bg-brand-500/90 text-white"
                : "bg-black/50 text-white/80 hover:bg-brand-500/80 hover:text-white"
            )}
          >
            <Bookmark className={cn("w-3.5 h-3.5", saved && "fill-white")} />
          </button>
        </div>
      </Link>

      {/* Info */}
      <div className="p-3 space-y-2">
        <Link href={`/video/${displaySlug}`} className="block">
          <h3 className={cn(
            "font-medium text-sm line-clamp-2 group-hover:text-brand-400 transition-colors",
            isLight && "text-gray-800"
          )}>
            {video.title}
          </h3>
        </Link>

        <div className="flex items-center justify-between">
          {/* Creator info with verification badge */}
          <Link
            href={`/creator/${video.creator.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-2 hover:opacity-80 transition"
          >
            <div className={cn(
              "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium",
              isLight ? "bg-brand-100 text-brand-600" : "bg-surface-300/60 text-white/70"
            )}>
              {video.creator.displayName?.[0] || "C"}
            </div>
            <span className={cn(
              "text-xs truncate max-w-[120px]",
              isLight ? "text-gray-500" : "text-white/60"
            )}>
              {video.creator.displayName || "Creator"}
            </span>
            {video.creator.isVerified && (
              <BadgeCheck className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            )}
          </Link>

          <div className={cn(
            "flex items-center gap-1 text-xs",
            isLight ? "text-gray-400" : "text-white/40"
          )}>
            <Eye className="w-3 h-3" />
            {video.viewsCount.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}
