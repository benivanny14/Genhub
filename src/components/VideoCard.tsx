"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { Play, Clock, Eye, Heart, Bookmark, Lock, Loader2 } from "lucide-react";
import VerifiedBadge from "@/components/VerifiedBadge";
import { useVideoStatuses } from "@/hooks/useVideoStatuses";
import {
  PROCESSING_BADGE_LABEL,
  PROCESSING_BADGE_TITLE,
  type VideoStatus,
} from "@/lib/video-status";
import { formatTZS, formatDuration } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import { displayHandle } from "@/lib/usernames";
import { categoryHref, getCategory } from "@/lib/categories";

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
  /**
   * Category id as stored on the scene (see lib/categories). Rendered as a tag
   * under the title so a grid reads like a catalogue of scenes rather than a
   * wall of covers. An id with no registry entry simply renders no tag.
   */
  category?: string | null;
  /**
   * Publication state from the API. `PROCESSING` means the post is real and
   * visible but the host is still transcoding it: the card shows the cover and
   * an "Inachakatwa..." badge, and nothing that could try to play.
   */
  status?: VideoStatus;
  /** False while the video cannot be served yet — no hover preview. */
  playable?: boolean;
  /** Bunny's 0-100, shown under the badge while processing. */
  encodeProgress?: number;
  creator: {
    id: string;
    /** Unique public handle; shown as @username when present. */
    username?: string | null;
    displayName: string | null;
    avatarUrl?: string | null;
    isVerified?: boolean;
  };
  createdAt: string;
}

export default function VideoCard(video: VideoCardProps) {
  const displaySlug = video.slug || video.id;
  // Resolved here rather than passed in: every grid already hands the whole
  // video over, so the label cannot drift from the id it came with.
  const tag = video.category ? getCategory(video.category) ?? null : null;
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

  // A processing post is live but cannot play, so the card watches it and
  // turns into a normal card by itself when the host finishes — no reload, and
  // no hover spending a request on a playlist that 404s until then.
  const initialStatus: VideoStatus = video.status ?? "READY";
  const liveStatus = useVideoStatuses(
    initialStatus === "PROCESSING" ? [video.id] : []
  );
  const live = liveStatus[video.id];
  const status: VideoStatus = live?.status ?? initialStatus;
  const processing = status === "PROCESSING";
  const progress = Math.max(
    0,
    Math.min(100, live?.progress ?? video.encodeProgress ?? 0)
  );

  // The creator's own trailer when there is one; otherwise the clip cut from
  // the scene, so a PAID card previews like any other card instead of sitting
  // there as a still. Both are HLS manifests our own routes serve, so the card
  // never talks to the CDN directly.
  //
  // Null unless the host can serve it: there is no manifest to load while the
  // video is being transcoded (or after an encode failed), and a hover that
  // fetches a 404 is how a card that is working correctly looks broken.
  const canPlay = !processing && video.playable !== false;
  const previewSrc = canPlay ? video.teaserUrl || video.introUrl || null : null;

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
            className={cn(
              "object-cover transition-transform duration-500",
              processing ? "opacity-70" : "group-hover:scale-105"
            )}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          />
        ) : (
          /* No cover yet. A flat panel with a faint play glyph reads as a
             broken image, and on a fresh catalogue most cards are in this
             state — so it gets the scene's own initial over a brand-tinted
             gradient: recognisable per card, and obviously deliberate. */
          <div
            className={cn(
              "w-full h-full flex items-center justify-center",
              isLight
                ? "bg-gradient-to-br from-brand-500/10 to-gray-200"
                : "bg-gradient-to-br from-brand-500/15 via-surface-300 to-surface-400"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "font-display font-bold text-5xl select-none",
                isLight ? "text-brand-500/20" : "text-white/10"
              )}
            >
              {(video.title.trim()[0] || "G").toUpperCase()}
            </span>
          </div>
        )}

        {/* Bottom scrim — keeps the duration and like buttons readable over a
            bright cover, the way a broadcast caption stays legible. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />

        {/* Play Button Overlay — and out of the way of a running preview. Not
            rendered at all while processing: a play button over a video that
            cannot play is the one thing this badge exists to replace. */}
        {!processing && (
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
              previewing ? "opacity-0" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <div className="w-14 h-14 rounded-full bg-brand-500/80 backdrop-blur-sm flex items-center justify-center shadow-lg shadow-brand-500/30">
              <Play className="w-6 h-6 text-white fill-white ml-0.5" />
            </div>
          </div>
        )}

        {/* "Inachakatwa..." — the post is live, the bytes are still becoming a
            video. It replaces the play affordance rather than sitting beside
            it, and it carries the real percentage so a creator can tell a slow
            encode from a stuck one. */}
        {processing && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/45 backdrop-blur-[2px] px-3 text-center"
            title={PROCESSING_BADGE_TITLE}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/40">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {PROCESSING_BADGE_LABEL}
            </span>
            <div className="w-24 bg-white/20 rounded-full h-1 overflow-hidden">
              <div
                className="bg-amber-400 h-full transition-all duration-500"
                style={{ width: `${Math.max(4, progress)}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-white/70">{progress}%</span>
          </div>
        )}

        {/* Preview indicator */}
        {previewing && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded-full text-[10px] font-medium text-white/90 pointer-events-none z-10">
            ▶ Preview
          </div>
        )}

        {/* Duration Badge — the one number a viewer looks for before deciding.
            Tabular figures so a 1:02:05 scene does not jitter the badge wider
            than the 9:41 one beside it. */}
        {!!video.duration && video.duration > 0 && (
          <div className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-0.5 text-xs font-semibold tabular-nums text-white ring-1 ring-white/15 backdrop-blur-sm">
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

        {/* Category tag — links into the category's own browse page, so the tag
            is a way in rather than decoration. */}
        {tag && (
          <Link
            href={categoryHref(tag.id)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors",
              isLight
                ? "border-brand-500/25 bg-brand-500/10 text-brand-600 hover:border-brand-500/50"
                : "border-brand-500/30 bg-brand-500/10 text-brand-300 hover:border-brand-400/60 hover:text-brand-200"
            )}
          >
            {tag.label}
          </Link>
        )}

        {/* `min-w-0` on the handle and `shrink-0` on the count: at two cards
            across on a phone the two would otherwise fight for the same pixels,
            so the handle truncates and the view count keeps its digits. */}
        <div className="flex items-center justify-between gap-2">
          {/* Creator info with verification badge */}
          <Link
            href={`/creator/${video.creator.id}`}
            onClick={(e) => e.stopPropagation()}
            className="flex min-w-0 items-center gap-2 hover:opacity-80 transition"
          >
            <div className={cn(
              "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium",
              isLight ? "bg-brand-100 text-brand-600" : "bg-surface-300/60 text-white/70"
            )}>
              {(video.creator.username?.[0] || video.creator.displayName?.[0] || "C").toUpperCase()}
            </div>
            <span className={cn(
              "text-xs truncate",
              isLight ? "text-gray-500" : "text-white/60"
            )}>
              {displayHandle(video.creator, "Creator")}
            </span>
            {video.creator.isVerified && <VerifiedBadge className="h-4 w-4" />}
          </Link>

          <div className={cn(
            "flex shrink-0 items-center gap-1 text-xs tabular-nums",
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
