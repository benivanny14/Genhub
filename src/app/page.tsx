"use client";

import { useState, useEffect, useRef } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import Image from "next/image";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import VideoCard from "@/components/VideoCard";
import { Search, Filter, Play, PlayCircle, TrendingUp, Clock, DollarSign, Zap, Crown, Flame, Star, Users, BadgeCheck, ArrowRight, LayoutGrid, Sparkles } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  filterDemoVideos,
  demoTeaserFor as demoTeaserFrom,
  DEMO_CREATORS,
  DEMO_VIDEOS,
  type DemoVideo,
} from "@/lib/demo-data";
import { CATEGORIES, categoryHref } from "@/lib/categories";
import { demoDataEnabled } from "@/lib/demo-mode";
import { pickFreshRows } from "@/lib/home-rows";
import { useInfiniteVideos, type InfiniteVideoQuery } from "@/hooks/useInfiniteVideos";

interface HistoryItem {
  id: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  duration: number | null;
  creator: { id: string; displayName: string | null };
  percent: number;
}

interface Video {
  id: string;
  teaserUrl?: string | null;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  teaserDuration: number;
  duration: number | null;
  viewsCount: number;
  likesCount?: number;
  purchaseCount?: number;
  category: string | null;
  isPremium?: boolean;
  isFeatured?: boolean;
  createdAt: string;
  creator: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
    isVerified?: boolean;
  };
}

interface UserData {
  role?: string;
}

interface FeedCreator {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  videoCount: number;
}

interface HomeFeed {
  featured: Video | null;
  rows: {
    new: Video[];
    popular: Video[];
    rated: Video[];
    free: Video[];
    trending: Video[];
  };
  categories: Record<string, number>;
  totalVideos: number;
  /** Creators with at least one published video — the same rule the strip uses. */
  totalCreators: number;
  creators: FeedCreator[];
}

const CATEGORY_IDS = ["", "music", "comedy", "education", "sports", "lifestyle", "tech", "exclusive"];
const CATEGORY_KEYS = ["cat.all", "cat.music", "cat.comedy", "cat.education", "cat.sports", "cat.lifestyle", "cat.tech", "cat.exclusive"];

const SORT_VALUES = ["newest", "popular", "rated", "price_low", "price_high", "trending"];
const SORT_KEYS = ["sort.newest", "sort.popular", "sort.rated", "sort.priceLow", "sort.priceHigh", "sort.trending"];

const DURATION_VALUES = ["", "short", "medium", "long"];
const DURATION_LABELS = ["Any length", "Under 5 min", "5–20 min", "20+ min"];

const DATE_VALUES = ["", "day", "week", "month", "year"];
const DATE_LABELS = ["Any time", "Today", "This week", "This month", "This year"];

// Page size for the video grid — small enough that infinite scroll actually
// kicks in (24 demo videos => 2 pages), realistic for production too.
const PAGE_SIZE = 12;

// Brazzers-style category browser: image tiles viewers tap to open /browse/[category]
const CATEGORY_TILES = CATEGORIES.map((c) => ({
  // home chips use "" for "all"; browse URLs use the "all" slug
  id: c.id === "all" ? "" : c.id,
  label: c.label,
  href: categoryHref(c.id),
  img: `https://picsum.photos/seed/${c.imageSeed}/480/320`,
}));

// Demo fallback when /api/home-feed is unreachable — same shapes, static data.
// `toFeedVideo` comes from lib/demo-data so the raw record's FULL scene is never
// published as `teaserUrl` (what a non-buyer may play); it is unit-tested there.
const toFeedVideo = (v: DemoVideo) =>
  ({ ...(v as unknown as Video), teaserUrl: demoTeaserFrom(v) }) as Video;

function buildDemoFeed(): HomeFeed {
  const all = filterDemoVideos({}).map(toFeedVideo);
  const byNew = [...all].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const byViews = [...all].sort((a, b) => b.viewsCount - a.viewsCount);
  const byLikes = [...all].sort((a, b) => (b.likesCount || 0) - (a.likesCount || 0));
  const free = all.filter((v) => v.price === 0);
  const categories: Record<string, number> = { "": all.length };
  for (const v of all) {
    if (v.category) categories[v.category] = (categories[v.category] || 0) + 1;
  }
  return {
    featured: byNew.find((v) => v.isFeatured) || byNew[0] || null,
    rows: {
      new: byNew.slice(0, 10),
      popular: byViews.slice(0, 10),
      rated: byLikes.slice(0, 10),
      free: free.slice(0, 10),
      trending: byViews.slice(0, 10),
    },
    categories,
    totalVideos: all.length,
    totalCreators: DEMO_CREATORS.filter((c) =>
      DEMO_VIDEOS.some((v) => v.creator.id === c.id)
    ).length,
    creators: DEMO_CREATORS.map((c) => ({
      ...c,
      videoCount: DEMO_VIDEOS.filter((v) => v.creator.id === c.id).length,
    })),
  };
}

/**
 * A real, empty feed — what the sections render when there is nothing to show.
 *
 * This exists so a failed request degrades honestly instead of hanging: the
 * skeletons below are for "still loading", and without this a production page
 * whose /api/home-feed failed would show them forever.
 */
function emptyFeed(): HomeFeed {
  return {
    featured: null,
    rows: { new: [], popular: [], rated: [], free: [], trending: [] },
    categories: { "": 0 },
    totalVideos: 0,
    totalCreators: 0,
    creators: [],
  };
}

// =============================================================================
// Loading skeletons — shown while /api/home-feed is in flight so the page
// never flashes empty sections
// =============================================================================
function TileSkeletons() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="skeleton rounded-xl aspect-[16/9]" />
      ))}
    </div>
  );
}

function HeroSkeleton() {
  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
      <div className="skeleton rounded-2xl aspect-[16/7]" />
    </section>
  );
}

function CreatorsSkeleton() {
  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8">
      <div className="skeleton h-6 w-44 rounded-lg mb-4" />
      <div className="flex gap-5 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2 w-24 shrink-0">
            <div className="skeleton w-20 h-20 rounded-full" />
            <div className="skeleton h-3 w-16 rounded" />
          </div>
        ))}
      </div>
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div className="pt-4 space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <section key={i} className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="skeleton h-6 w-40 rounded-lg mb-4" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 5 }).map((_, j) => (
              <div key={j} className="w-60 sm:w-64 shrink-0 space-y-2">
                <div className="skeleton aspect-video rounded-xl" />
                <div className="skeleton h-4 w-3/4 rounded" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// =============================================================================
// Horizontal video row (Brazzers-style shelf) with a "See all" jump to the grid
// =============================================================================
function RowSection({
  title,
  icon,
  videos,
  onSeeAll,
  isLight,
}: {
  title: string;
  icon: React.ReactNode;
  videos: Video[];
  onSeeAll: () => void;
  isLight: boolean;
}) {
  if (!videos.length) return null;
  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2
          className={cn(
            "font-display font-bold text-lg flex items-center gap-2",
            isLight && "text-gray-900"
          )}
        >
          {icon}
          {title}
        </h2>
        <button
          onClick={onSeeAll}
          className="text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1 transition shrink-0"
        >
          See all <ArrowRight className="w-4 h-4" />
        </button>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-none">
        {videos.map((v) => (
          <div key={v.id} className="w-60 sm:w-64 shrink-0">
            <VideoCard {...v} createdAt={v.createdAt} />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function HomePage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("newest");
  const [duration, setDuration] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [user, setUser] = useState<UserData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  const { t } = useI18n();
  const isLight = theme === "light";

  // Shared infinite-scroll grid — resets to page 1 on any filter/search change
  const gridQuery: InfiniteVideoQuery = {
    q: search,
    category,
    sort,
    duration,
    date: dateFilter,
    pageSize: PAGE_SIZE,
  };
  const {
    videos,
    page,
    totalPages,
    hasMore,
    loading,
    loadingMore,
    loadMore,
    reload,
  } = useInfiniteVideos<Video>(
    gridQuery,
    // Development only: when the API is unreachable the grid still has something
    // to show. In a production bundle this argument is `undefined`, so an empty
    // query result stays an empty grid instead of becoming 24 invented scenes.
    demoDataEnabled()
      ? (targetPage) => {
          const all = filterDemoVideos({
            q: search,
            category,
            sort,
            duration,
            date: dateFilter,
          }).map(toFeedVideo);
          const start = (targetPage - 1) * PAGE_SIZE;
          return {
            videos: all.slice(start, start + PAGE_SIZE),
            totalPages: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
          };
        }
      : undefined
  );

  // Load account + watch history once on mount
  useEffect(() => {
    fetchUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read ?q= from the URL (header / autocomplete search)
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q) setSearch(q);
    } catch {}
  }, []);

  // Curated front-page sections (featured, rows, categories, creators) — one call
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/home-feed");
        const data = await res.json();
        if (!cancelled && data.success) setFeed(data.data);
      } catch {
        // unreachable DB — handled below, where the fallback is decided
      }
      // Two different recoveries, and the difference is the whole point:
      // development gets the demo feed so the layout is explorable without a
      // database, production gets an empty feed so a launched site never
      // advertises scenes that do not exist. Without the second branch a failed
      // request would leave `feed` null and the skeletons up forever.
      if (!cancelled) {
        setFeed((prev) => prev || (demoDataEnabled() ? buildDemoFeed() : emptyFeed()));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Infinite scroll: load the next page when the sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  async function fetchUser() {
    try {
      const res = await fetchCurrentUser();
      const data = await res.json();
      if (data.success) {
        setUser(data.data);
        fetchHistory();
      }
    } catch {}
  }

  async function fetchHistory() {
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      if (data.success) setHistory(data.data.videos || []);
    } catch {}
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    reload();
  };

  // Category tile / row "See all": apply the sort+filter, then jump to the grid
  function goToGrid(nextSort?: string) {
    if (nextSort && nextSort !== sort) {
      setSort(nextSort);
    }
    document.getElementById("video-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // What the shelves and the category grid are allowed to show.
  //
  // Two rules, both about a small catalogue: a shelf keeps only videos not
  // already shown above it (lib/home-rows.ts), and a category with nothing in it
  // is not offered. "All Videos" always stays — it is the way back.
  const rows = feed ? pickFreshRows(feed.rows) : null;
  const tiles = feed
    ? CATEGORY_TILES.filter(
        (tile) => tile.id === "" || (feed.categories[tile.id] ?? 0) > 0
      )
    : CATEGORY_TILES;

  return (
    <div className="min-h-screen page-enter">
      <Header />

      {/* Hero Section */}
      <section className={cn(
        "relative overflow-hidden",
        isLight
          ? "bg-gradient-to-b from-brand-100/60 via-[#f0edf6] to-[#f0edf6]"
          : "bg-gradient-to-b from-brand-500/10 via-surface-500 to-surface-500"
      )}>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.15),transparent_70%)]" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 md:py-20 relative">
          <div className="text-center max-w-3xl mx-auto">
            {/* Premium Badge */}
            <div className="inline-flex items-center gap-2 bg-brand-500/10 border border-brand-500/20 rounded-full px-4 py-1.5 mb-6 text-sm font-medium text-brand-400">
              <Crown className="w-4 h-4" />
              Premium Content Platform
            </div>

            <h1 className={cn(
              "text-4xl md:text-6xl font-display font-bold mb-4",
              isLight && "text-gray-900"
            )}>
              <span className="text-gradient">{t("home.heroTitle")}</span>
            </h1>
            <p className={cn(
              "text-lg md:text-xl mb-8 whitespace-pre-line",
              isLight ? "text-gray-500" : "text-white/60"
            )}>
              {t("home.heroDesc")}
            </p>

            {/* Search Bar */}
            <form onSubmit={handleSearch} className="max-w-lg mx-auto relative">
              <Search className={cn(
                "absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5",
                isLight ? "text-gray-400" : "text-white/40"
              )} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("home.searchPlaceholder")}
                className="input-field pl-12 pr-24 py-4 text-base"
              />
              <button
                type="submit"
                className="absolute right-2 top-1/2 -translate-y-1/2 btn-brand py-2 px-4 text-sm"
              >
                {t("home.search")}
              </button>
            </form>

            {/* Stats Bar */}
            <div className={cn(
              "flex items-center justify-center gap-6 mt-8 text-sm",
              isLight ? "text-gray-400" : "text-white/40"
            )}>
              {/* Real counts or nothing. These two chips used to read
                  "10K+ Creators" and "50K+ Videos" on every deployment, which
                  on a catalogue of one is a claim the visitor can disprove in
                  ten seconds by scrolling — and the number they then trust is
                  neither. `feed === null` means "still loading", which is the
                  one case where saying nothing is honest. */}
              {feed && (
                <>
                  <span className="flex items-center gap-1.5">
                    <Users className="w-4 h-4" />
                    {feed.totalCreators.toLocaleString()}{" "}
                    {feed.totalCreators === 1 ? "Creator" : "Creators"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Play className="w-4 h-4" />
                    {feed.totalVideos.toLocaleString()}{" "}
                    {feed.totalVideos === 1 ? "Video" : "Videos"}
                  </span>
                </>
              )}
              <span className="flex items-center gap-1.5"><Zap className="w-4 h-4" /> Instant Access</span>
            </div>
          </div>
        </div>
      </section>

      {/* Category Browser — Brazzers-style image tiles */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-2">
        <div className="flex items-center justify-between mb-4">
          <h2
            className={cn(
              "font-display font-bold text-lg flex items-center gap-2",
              isLight && "text-gray-900"
            )}
          >
            <LayoutGrid className="w-5 h-5 text-brand-400" /> Browse Categories
          </h2>
        </div>
        {!feed ? (
          <TileSkeletons />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {tiles.map((tile) => {
              const active = category === tile.id;
              return (
                <Link
                  key={tile.id}
                  href={tile.href}
                  className={cn(
                    "group relative overflow-hidden rounded-xl border aspect-[16/9] transition",
                    active
                      ? "border-brand-500 ring-2 ring-brand-500/40"
                      : "border-white/10 hover:border-brand-500/60"
                  )}
                >
                  <Image
                    src={tile.img}
                    alt={tile.label}
                    fill
                    sizes="(max-width: 640px) 50vw, 20vw"
                    className="object-cover opacity-70 group-hover:opacity-95 group-hover:scale-105 transition"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
                  <div className="absolute inset-0 flex flex-col items-center justify-end pb-2.5 text-center">
                    <span className="text-sm font-bold text-white drop-shadow">
                      {tile.label}
                    </span>
                    <span className="text-[11px] text-brand-300 font-medium">
                      {tile.id === "" ? feed.totalVideos : feed.categories[tile.id] ?? 0}{" "}
                      videos
                    </span>
                  </div>
                  {active && (
                    <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-brand-400 shadow-[0_0_8px_theme(colors.brand.400)]" />
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Featured Hero Video */}
      {feed === null ? (
        <HeroSkeleton />
      ) : feed.featured && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
          <Link
            href={`/video/${feed.featured.slug || feed.featured.id}`}
            className="group relative block rounded-2xl overflow-hidden aspect-[16/7] border border-white/10"
          >
            {feed.featured.thumbnailUrl ? (
              <Image
                src={feed.featured.thumbnailUrl}
                alt={feed.featured.title}
                fill
                sizes="(max-width: 1280px) 100vw, 1200px"
                className="object-cover group-hover:scale-105 transition duration-500"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-brand-700 via-accent-700 to-gray-950" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
            <div className="absolute top-4 left-4 flex items-center gap-2">
              <span className="bg-brand-500 text-black text-[11px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide">
                ⭐ Featured
              </span>
              {feed.featured.isPremium && (
                <span className="bg-gold/90 text-black text-[11px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide">
                  Premium
                </span>
              )}
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-7">
              <div className="flex items-center gap-2 text-xs text-gray-300 mb-2">
                <span className="font-semibold text-brand-300">
                  {feed.featured.creator.displayName}
                </span>
                {feed.featured.creator.isVerified && (
                  <BadgeCheck className="w-3.5 h-3.5 text-sky-400" />
                )}
                <span>•</span>
                <span>{feed.featured.viewsCount.toLocaleString()} views</span>
                {feed.featured.duration && (
                  <>
                    <span>•</span>
                    <span>{formatDuration(feed.featured.duration)}</span>
                  </>
                )}
              </div>
              <h2 className="font-display font-bold text-xl sm:text-3xl text-white drop-shadow line-clamp-1 mb-3">
                {feed.featured.title}
              </h2>
              <span className="inline-flex items-center gap-2 bg-brand-500 hover:bg-brand-400 text-black font-bold text-sm px-5 py-2.5 rounded-full transition">
                <Play className="w-4 h-4 fill-current" /> Watch Now
              </span>
            </div>
          </Link>
        </section>
      )}

      {/* Continue Watching */}
      {history.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
          <h2 className={cn(
            "font-display font-bold text-lg mb-4 flex items-center gap-2",
            isLight && "text-gray-900"
          )}>
            <Play className="w-5 h-5 text-brand-400" /> Continue Watching
          </h2>
          <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-none">
            {history.map((h) => (
              <Link key={h.id} href={`/video/${h.slug || h.id}`} className="group w-56 shrink-0">
                <div className="relative aspect-video rounded-xl overflow-hidden bg-surface-300/60">
                  {h.thumbnailUrl ? (
                    <Image
                      src={h.thumbnailUrl}
                      alt={h.title}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      sizes="224px"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Play className="w-8 h-8 text-white/30" />
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50">
                    <div className="h-full bg-brand-500" style={{ width: `${h.percent}%` }} />
                  </div>
                  <span className="absolute top-2 right-2 bg-black/70 text-[10px] px-1.5 py-0.5 rounded text-white">
                    {h.percent}%
                  </span>
                </div>
                <p className={cn(
                  "text-sm mt-2 line-clamp-2 group-hover:text-brand-400 transition",
                  isLight ? "text-gray-800" : "text-white/90"
                )}>
                  {h.title}
                </p>
                <p className={cn(
                  "text-xs mt-0.5 truncate",
                  isLight ? "text-gray-400" : "text-white/40"
                )}>
                  {h.creator.displayName || "Creator"}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Popular Creators strip */}
      {feed === null ? (
        <CreatorsSkeleton />
      ) : feed.creators.length > 0 && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8">
          <div className="flex items-center justify-between mb-4">
            <h2
              className={cn(
                "font-display font-bold text-lg flex items-center gap-2",
                isLight && "text-gray-900"
              )}
            >
              <Flame className="w-5 h-5 text-accent-400" /> Popular Creators
            </h2>
            <button
              onClick={() => (window.location.href = "/creators")}
              className="text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1"
            >
              See all <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-5 overflow-x-auto pb-2 scrollbar-none">
            {feed.creators.map((c) => (
              <Link
                key={c.id}
                href={`/creator/${c.id}`}
                className="group flex flex-col items-center gap-2 w-24 shrink-0 text-center"
              >
                <div
                  className={cn(
                    "w-20 h-20 rounded-full overflow-hidden border-2 transition group-hover:border-brand-400 group-hover:scale-105",
                    isLight ? "border-gray-200" : "border-white/15"
                  )}
                >
                  {c.avatarUrl ? (
                    <Image
                      src={c.avatarUrl}
                      alt={c.displayName || "Creator"}
                      width={80}
                      height={80}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-brand-600 font-bold text-xl text-white">
                      {c.displayName?.[0]?.toUpperCase() || "C"}
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    "text-xs font-medium truncate max-w-full group-hover:text-brand-400 transition flex items-center gap-1",
                    isLight ? "text-gray-700" : "text-gray-300"
                  )}
                >
                  {c.displayName}
                  {c.isVerified && <BadgeCheck className="w-3 h-3 text-sky-400 shrink-0" />}
                </span>
                <span className="text-[10px] text-gray-500">
                  {c.videoCount} videos
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Brazzers-style video rows */}
      {feed === null || !rows ? (
        <RowsSkeleton />
      ) : (
        <div className="pt-4 space-y-2">
          <RowSection
            title="New Releases"
            icon={<Clock className="w-5 h-5 text-brand-400" />}
            videos={rows.new}
            isLight={isLight}
            onSeeAll={() => goToGrid("newest")}
          />
          <RowSection
            title="Most Popular"
            icon={<TrendingUp className="w-5 h-5 text-accent-400" />}
            videos={rows.popular}
            isLight={isLight}
            onSeeAll={() => goToGrid("popular")}
          />
          <RowSection
            title="Top Rated"
            icon={<Star className="w-5 h-5 text-gold" />}
            videos={rows.rated}
            isLight={isLight}
            onSeeAll={() => goToGrid("rated")}
          />
          <RowSection
            title="Free to Watch"
            icon={<PlayCircle className="w-5 h-5 text-emerald-400" />}
            videos={rows.free}
            isLight={isLight}
            onSeeAll={() => goToGrid("price_low")}
          />
          <RowSection
            title="🔥 Trending Now"
            icon={<Flame className="w-5 h-5 text-orange-400" />}
            videos={rows.trending}
            isLight={isLight}
            onSeeAll={() => goToGrid("trending")}
          />
        </div>
      )}

      {/* Filters */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
            {CATEGORY_IDS.map((catId, i) => (
              <button
                key={catId}
                onClick={() => setCategory(catId)}
                className={cn(
                  "whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition-all",
                  category === catId
                    ? "bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                    : isLight
                      ? "bg-white text-gray-500 hover:text-gray-900 hover:bg-brand-50 border border-gray-200"
                      : "bg-surface-400/60 text-white/60 hover:text-white hover:bg-surface-400"
                )}
              >
                {t(CATEGORY_KEYS[i])}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Filter className={cn("w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className={cn(
                "rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 border",
                isLight
                  ? "bg-white border-gray-200 text-gray-700"
                  : "bg-surface-400/60 border-white/10 text-white"
              )}
              title="Filter by length"
            >
              {DURATION_VALUES.map((val, i) => (
                <option key={val} value={val}>{DURATION_LABELS[i]}</option>
              ))}
            </select>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className={cn(
                "rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 border",
                isLight
                  ? "bg-white border-gray-200 text-gray-700"
                  : "bg-surface-400/60 border-white/10 text-white"
              )}
              title="Filter by upload date"
            >
              {DATE_VALUES.map((val, i) => (
                <option key={val} value={val}>{DATE_LABELS[i]}</option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className={cn(
                "rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 border",
                isLight
                  ? "bg-white border-gray-200 text-gray-700"
                  : "bg-surface-400/60 border-white/10 text-white"
              )}
            >
              {SORT_VALUES.map((val, i) => (
                <option key={val} value={val}>
                  {t(SORT_KEYS[i])}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Video Grid */}
      <main id="video-grid" className="max-w-7xl mx-auto px-4 sm:px-6 pb-24 md:pb-20 scroll-mt-20">
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="skeleton aspect-video" />
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="text-center py-20">
            <Play className={cn("w-16 h-16 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/10")} />
            <h3 className={cn("text-lg font-medium mb-2", isLight ? "text-gray-500" : "text-white/60")}>
              {t("home.noVideos")}
            </h3>
            <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
              {t("home.beFirst")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
            {videos.map((video) => (
              <VideoCard key={video.id} {...video} createdAt={video.createdAt} />
            ))}
          </div>
        )}

        {/* Infinite-scroll sentinel + manual fallback */}
        <div ref={sentinelRef} className="h-1" />
        {page < totalPages && (
          <div className="flex justify-center mt-8">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="btn-ghost disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
        {totalPages > 1 && page >= totalPages && (
          <p className={cn("text-center text-xs mt-8", isLight ? "text-gray-400" : "text-white/30")}>
            That&apos;s everything — {videos.length} videos
          </p>
        )}
      </main>

      <BottomNav userRole={user?.role} />
    </div>
  );
}
