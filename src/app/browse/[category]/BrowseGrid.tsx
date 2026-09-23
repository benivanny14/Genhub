"use client";

// =============================================================================
// GENHUB - Browse grid (client half of /browse/[category])
// Thin UI over the shared useInfiniteVideos hook: sort controls + load-more
// paging over /api/videos for one category, reusing the homepage VideoCard grid.
// =============================================================================

import { useState } from "react";
import VideoCard from "@/components/VideoCard";
import { PlayCircle, Loader2, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useInfiniteVideos,
  type InfiniteVideoQuery,
} from "@/hooks/useInfiniteVideos";

interface BrowseVideo {
  id: string;
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

const PAGE_SIZE = 24;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Popular" },
  { value: "rated", label: "Top Rated" },
  { value: "trending", label: "🔥 Trending" },
  { value: "price_low", label: "Price: Low → High" },
  { value: "price_high", label: "Price: High → Low" },
];

export default function BrowseGrid({
  category,
  label,
}: {
  /** "" means the pseudo-category "all" */
  category: string;
  label: string;
}) {
  const [sort, setSort] = useState("newest");

  const query: InfiniteVideoQuery = { category, sort, pageSize: PAGE_SIZE };
  const {
    videos,
    total,
    page,
    totalPages,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    reload,
  } = useInfiniteVideos<BrowseVideo>(query);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <p className="text-sm text-gray-400">
          <span className="text-white font-medium">{total.toLocaleString()}</span>{" "}
          video{total === 1 ? "" : "s"} in {label}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="browse-sort" className="text-xs text-gray-500 shrink-0">
            Sort by
          </label>
          <select
            id="browse-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg text-sm px-3 py-2 text-white focus:border-brand-500 focus:outline-none"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-gray-900">
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Grid / states */}
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
      ) : error ? (
        <div className="text-center py-16">
          <PlayCircle className="w-12 h-12 mx-auto mb-3 text-white/15" />
          <p className="text-gray-400 text-sm">{error}</p>
          <button onClick={reload} className="btn-ghost mt-4">
            Try again
          </button>
        </div>
      ) : videos.length === 0 ? (
        <div className="text-center py-16">
          <SearchX className="w-12 h-12 mx-auto mb-3 text-white/15" />
          <h3 className="text-lg font-medium text-white/70 mb-1">
            No videos in {label} yet
          </h3>
          <p className="text-sm text-gray-500">
            Check back soon — creators are publishing every day.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
          {videos.map((video) => (
            <VideoCard key={video.id} {...video} createdAt={video.createdAt} />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center mt-8">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="btn-ghost disabled:opacity-50"
          >
            {loadingMore ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </span>
            ) : (
              "Load more"
            )}
          </button>
        </div>
      )}
      {totalPages > 1 && page >= totalPages && !loading && (
        <p
          className={cn(
            "text-center text-xs mt-8",
            "text-white/30"
          )}
        >
          That&apos;s everything — {videos.length} videos
        </p>
      )}
    </div>
  );
}
