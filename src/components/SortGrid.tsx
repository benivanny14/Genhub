"use client";

// =============================================================================
// GENHUB - Fixed-sort video grid
// Powers the dedicated discovery pages (/trending, /top-rated, /most-viewed).
// Same paging + card grid as the category browser, but the ordering is fixed by
// the page instead of a dropdown.
// =============================================================================

import VideoCard from "@/components/VideoCard";
import { PlayCircle, Loader2 } from "lucide-react";
import { useInfiniteVideos, type InfiniteVideoQuery } from "@/hooks/useInfiniteVideos";

interface SortVideo {
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

export default function SortGrid({
  sort,
  emptyMessage,
}: {
  sort: string;
  emptyMessage: string;
}) {
  const query: InfiniteVideoQuery = { sort, pageSize: PAGE_SIZE };
  const { videos, total, loading, loadingMore, error, loadMore, reload } =
    useInfiniteVideos<SortVideo>(query);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="skeleton aspect-video" />
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16">
        <PlayCircle className="w-12 h-12 mx-auto mb-3 text-white/15" />
        <p className="text-gray-400 text-sm">{error}</p>
        <button onClick={reload} className="btn-ghost mt-4">
          Try again
        </button>
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="text-center py-16">
        <PlayCircle className="w-12 h-12 mx-auto mb-3 text-white/15" />
        <p className="text-gray-400 text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-gray-400 mb-5">
        <span className="text-white font-medium">{total.toLocaleString()}</span> videos
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
        {videos.map((video) => (
          <VideoCard key={video.id} {...video} createdAt={video.createdAt} />
        ))}
      </div>

      {videos.length < total && (
        <div className="flex justify-center mt-8">
          <button onClick={loadMore} disabled={loadingMore} className="btn-ghost disabled:opacity-50">
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
    </div>
  );
}
