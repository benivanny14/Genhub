"use client";

// =============================================================================
// GENHUB - Watch history & Continue watching
//
// Every scene this viewer has started, with how far they got. Resume already
// worked on the watch page (the progress is stored); this is the missing door —
// the place that answers "what was I watching?" without remembering a title.
//
// "Continue watching" is the top section and keeps only what is genuinely in
// progress (started, not finished). Everything else is ordinary history.
// =============================================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import { useCurrency } from "@/lib/currency";
import { formatRelativeTime } from "@/lib/utils";
import { displayHandle } from "@/lib/usernames";
import { canOptimizeImage } from "@/lib/media";
import { useAllVideosFree } from "@/hooks/useSiteFlags";
import { usePurchasedVideoIds } from "@/hooks/usePurchasedVideos";
import { History, Play, Clock, Loader2 } from "lucide-react";

interface HistoryItem {
  videoId: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  price: number;
  category: string | null;
  creator: {
    id: string;
    username?: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isVerified?: boolean;
  };
  positionSeconds: number;
  percent: number;
  updatedAt: string;
}

/** Started but not finished — the only rows worth offering to resume. */
function isInProgress(item: HistoryItem): boolean {
  return item.percent > 0 && item.percent < 95;
}

export default function HistoryPage() {
  const { format } = useCurrency();
  // While every video is free, a row must not quote a price — it reads "Free",
  // which is what the viewer would actually be charged. See hooks/useSiteFlags.
  const allVideosFree = useAllVideosFree();
  // A row for a scene the viewer already paid for says "Paid" instead of
  // quoting its price again — the same rule the cards use.
  const purchased = usePurchasedVideoIds();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/watch-history");
        const data = await res.json();
        if (data.success) setItems(data.data.items as HistoryItem[]);
        else setError(data.error || "Could not load your history.");
      } catch {
        setError("Could not load your history.");
      }
    })();
  }, []);

  const cont = (items || []).filter(isInProgress);

  function Row({ item }: { item: HistoryItem }) {
    const href = `/video/${item.slug || item.videoId}`;
    const mins = item.duration ? Math.round(item.duration / 60) : null;

    return (
      <Link href={href} className="glass-card p-3 flex gap-3 hover:border-brand-500/40 transition">
        <div className="relative w-28 sm:w-36 aspect-video rounded-lg overflow-hidden bg-white/5 shrink-0">
          {item.thumbnailUrl ? (
            <Image
              src={item.thumbnailUrl}
              alt=""
              fill
              sizes="144px"
              unoptimized={!canOptimizeImage(item.thumbnailUrl)}
              className="object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Play className="w-6 h-6 text-white/20" />
            </div>
          )}
          {/* How far they got, drawn on the picture so the resume point is
              visible before the title is read. */}
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
            <div
              className="h-full bg-brand-500"
              style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate">{item.title}</p>
          <p className="text-xs text-white/50 truncate">
            {displayHandle(item.creator, "Creator")}
          </p>
          <p className="text-xs text-white/40 mt-1 flex items-center gap-2">
            <Clock className="w-3 h-3" />
            {formatRelativeTime(new Date(item.updatedAt))}
            {mins ? ` · ${mins} min` : ""}
            {allVideosFree
              ? " · Free"
              : purchased.has(item.videoId)
                ? " · Paid"
                : item.price > 0
                  ? ` · ${format(item.price)}`
                  : " · Free"}
          </p>
        </div>
      </Link>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold flex items-center gap-3">
            <History className="w-6 h-6 text-brand-400" /> Watch history
          </h1>
          <p className="text-sm mt-1 text-white/50">
            Everything you have started — pick up where you left off.
          </p>
        </div>

        {items === null && !error && (
          <div className="flex items-center gap-2 text-sm text-white/50 py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {items && items.length === 0 && (
          <div className="glass-card p-10 text-center">
            <History className="w-10 h-10 mx-auto mb-3 text-white/15" />
            <p className="text-sm text-white/50">
              Nothing here yet — start watching a scene and it will appear here.
            </p>
            <Link href="/" className="btn-brand inline-flex items-center gap-2 mt-4 text-sm">
              Browse videos
            </Link>
          </div>
        )}

        {cont.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wide">
              Continue watching
            </h2>
            {cont.map((item) => (
              <Row key={item.videoId} item={item} />
            ))}
          </section>
        )}

        {items && items.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wide">
              Earlier
            </h2>
            {items.map((item) => (
              <Row key={`all-${item.videoId}`} item={item} />
            ))}
          </section>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
