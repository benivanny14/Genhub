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

import { useEffect, useState } from "react";
import { Info, AlertTriangle, CheckCircle, X } from "lucide-react";

interface Announcement {
  active: boolean;
  message: string;
  tone: "info" | "warning" | "success";
}

const DISMISS_KEY = "genhub_announcement_dismissed";

const TONES: Record<Announcement["tone"], { wrap: string; icon: typeof Info }> = {
  info: { wrap: "border-sky-500/30 bg-sky-500/10 text-sky-200", icon: Info },
  warning: { wrap: "border-amber-500/30 bg-amber-500/10 text-amber-200", icon: AlertTriangle },
  success: { wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", icon: CheckCircle },
};

export default function SiteBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissed, setDismissed] = useState(false);

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

  if (!announcement?.active || !announcement.message || dismissed) return null;

  const tone = TONES[announcement.tone] || TONES.info;
  const Icon = tone.icon;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, announcement!.message);
    } catch {}
  }

  return (
    <div className={`border-b px-4 py-2 text-sm ${tone.wrap}`}>
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
