"use client";

// =============================================================================
// GENHUB - The site-wide announcement banner
//
// An admin publishes it from the panel without a deploy ("malipo yamerudi",
// "tunafanya matengenezo"), and it renders at the top of every page under the
// header. It reads the public /api/site/status, so a signed-out visitor sees it
// too — which is the whole point of an announcement.
//
// It renders NOTHING until the status answers, so the page never jumps for a
// banner that turns out to be inactive.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Info, AlertTriangle, CheckCircle, X, Megaphone } from "lucide-react";

interface Announcement {
  active: boolean;
  message: string;
  tone: "danger" | "info" | "warning" | "success";
}

const DISMISS_KEY = "genhub_announcement_dismissed";

/**
 * The CSS variable the sticky Header parks itself under.
 *
 * The banner is taller than one line when the message wraps, so its height is
 * measured rather than guessed: a hard-coded `top-10` would leave the header
 * floating over a two-line warning, or a gap under a one-line one. The header
 * reads `var(--site-banner-height, 0px)`, which is 0 while there is no banner.
 */
const BANNER_HEIGHT_VAR = "--site-banner-height";

/**
 * The banner's colours.
 *
 * `danger` is the loud one — a solid red bar with white text, not a tinted strip
 * that reads like decoration. An announcement is published so people stop and
 * read it ("malipo yamerudi", "tunafanya matengenezo"), and the default tone is
 * `danger` for exactly that reason. The tinted tones stay for the quiet cases.
 */
const TONES: Record<Announcement["tone"], { wrap: string; icon: typeof Info }> = {
  danger: {
    wrap: "border-red-700/60 bg-red-600/90 backdrop-blur-xl text-white font-medium",
    icon: Megaphone,
  },
  warning: {
    wrap: "border-amber-500/30 bg-amber-500/10 text-amber-200 backdrop-blur-xl",
    icon: AlertTriangle,
  },
  success: {
    wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 backdrop-blur-xl",
    icon: CheckCircle,
  },
  info: { wrap: "border-sky-500/30 bg-sky-500/10 text-sky-200 backdrop-blur-xl", icon: Info },
};

export default function SiteBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/site/status");
        const data = await res.json();
        if (!cancelled && data?.success) {
          setAnnouncement(data.data.announcement as Announcement);
          // Dismissal is remembered per message: a NEW announcement appears even
          // if the last one was closed.
          try {
            if (localStorage.getItem(DISMISS_KEY) === data.data.announcement?.message) {
              setDismissed(true);
            }
          } catch {}
        }
      } catch {
        // No banner on a failed read — an announcement is not worth an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = Boolean(announcement?.active && announcement.message) && !dismissed;

  // Declare the banner's height so the sticky Header can sit just below it. This
  // runs whether or not the banner is shown, so the variable is always defined
  // and is reset to 0 the moment the banner is dismissed or cleared — otherwise
  // the header would keep a stale offset and float over empty space.
  useEffect(() => {
    const root = document.documentElement;
    if (!shown) {
      root.style.setProperty(BANNER_HEIGHT_VAR, "0px");
      return;
    }
    const el = bannerRef.current;
    if (!el) return;

    const measure = () => root.style.setProperty(BANNER_HEIGHT_VAR, `${el.offsetHeight}px`);
    measure();

    // offsetHeight is correct after the first paint, but the message can wrap
    // differently at another width — a ResizeObserver keeps the header aligned
    // through a rotate or a window resize.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.setProperty(BANNER_HEIGHT_VAR, "0px");
    };
  }, [shown, announcement?.tone]);

  if (!announcement?.active || !announcement.message || dismissed) return null;

  // An unknown tone renders as the red one, matching the server's default (see
  // normalizeAnnouncementTone) — a banner that falls back to a quiet colour is
  // the banner nobody reads.
  const tone = TONES[announcement.tone] || TONES.danger;
  const Icon = tone.icon;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, announcement!.message);
    } catch {}
  }

  return (
    <div
      ref={bannerRef}
      // Sticky so an announcement stays in front of a scrolling reader; it is
      // the header that moves down to make room (see Header.tsx), which is why
      // this sits above the header's own z-index rather than under it.
      className={`sticky top-0 z-[60] border-b px-4 py-2 text-sm ${tone.wrap}`}
    >
      <div className="max-w-7xl mx-auto flex items-start gap-2">
        <Icon className="w-4 h-4 shrink-0 mt-0.5" />
        <p className="flex-1">{announcement.message}</p>
        <button
          onClick={dismiss}
          className="shrink-0 opacity-70 hover:opacity-100"
          aria-label="Dismiss announcement"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
