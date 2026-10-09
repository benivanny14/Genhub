"use client";

// =============================================================================
// GENHUB - Search results, fetched
//
// Videos and creators in one request each, in parallel, because a search that
// shows videos first and creators a second later reads as broken. Both calls go
// through the same endpoints the autocomplete uses.
//
// `AbortController` because the query prop changes as the visitor edits the URL
// or the header box — without it a slow first search can land after a fast
// second one and replace the correct results with stale ones.
//
// The query is put in the URL by whoever navigates here, so this component never
// guesses: it renders exactly what it was asked to.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Search, Loader2 } from "lucide-react";
import VideoCard from "@/components/VideoCard";
import VerifiedBadge from "@/components/VerifiedBadge";
import { displayHandle } from "@/lib/usernames";
import { useAllVideosFree } from "@/hooks/useSiteFlags";

interface VideoResult {
  id: string;
  title: string;
  slug?: string | null;
  thumbnailUrl?: string | null;
  teaserUrl?: string | null;
  price: number;
  duration?: number | null;
  viewsCount: number;
  teaserDuration: number;
  likesCount?: number;
  isPremium?: boolean;
  createdAt: string;
  creator: {
    id: string;
    username?: string | null;
    displayName: string | null;
    avatarUrl?: string | null;
    isVerified?: boolean;
  };
}

interface CreatorResult {
  id: string;
  username?: string | null;
  displayName: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean;
  videoCount?: number;
  subscriberCount?: number;
}

export default function SearchResults({ query }: { query: string }) {
  // While every video is free, filtering by price says nothing: every result
  // would match every band. The filter is hidden rather than left to mislead.
  const allVideosFree = useAllVideosFree();
  const [videos, setVideos] = useState<VideoResult[]>([]);
  const [creators, setCreators] = useState<CreatorResult[]>([]);
  const [loading, setLoading] = useState(Boolean(query));
  const [failed, setFailed] = useState(false);

  // Narrowing filters. They belong to the videos half only — a creator is not
  // priced or timed, so filtering creators by price would be meaningless.
  const [duration, setDuration] = useState(""); // "" | short | medium | long
  const [priceBand, setPriceBand] = useState(""); // "" | free | under2000 | ...
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!query) {
        setVideos([]);
        setCreators([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setFailed(false);

      const encoded = encodeURIComponent(query);

      // The filters are folded into the videos query only. Built as a
      // URLSearchParams rather than string-concatenated so the values cannot
      // inject into the query without encoding.
      const videoParams = new URLSearchParams({ q: query, limit: "24", sort: "popular" });
      if (duration) videoParams.set("duration", duration);
      if (priceBand === "free") videoParams.set("free", "1");
      else if (priceBand) videoParams.set("maxPrice", priceBand.replace(/^under/, ""));
      if (verifiedOnly) videoParams.set("verified", "1");

      try {
        const [videoRes, creatorRes] = await Promise.all([
          fetch(`/api/videos?${videoParams.toString()}`, { signal }),
          fetch(`/api/creators?q=${encoded}&limit=12`, { signal }),
        ]);

        // A failed half must not blank the successful half: showing the videos
        // that matched beats showing an error because the creator query timed out.
        const videoBody = await videoRes.json().catch(() => null);
        const creatorBody = await creatorRes.json().catch(() => null);

        if (videoBody?.success) setVideos(videoBody.data?.videos ?? []);
        if (creatorBody?.success) {
          const list = creatorBody.data?.creators ?? creatorBody.data ?? [];
          setCreators(Array.isArray(list) ? list : []);
        }
        setFailed(!videoBody?.success && !creatorBody?.success);
      } catch (error) {
        // An aborted request is a newer search replacing this one, not a failure.
        if ((error as { name?: string })?.name === "AbortError") return;
        console.error("[Search] request failed", error);
        setFailed(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [query, duration, priceBand, verifiedOnly]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // --- Nothing typed yet -----------------------------------------------------
  if (!query) {
    return (
      <div className="glass-panel flex flex-col items-center justify-center px-6 py-20 text-center">
        <Search className="mb-4 h-10 w-10 text-gray-500" />
        <h1 className="text-xl font-semibold text-white">Search Genhub</h1>
        <p className="mt-2 max-w-sm text-sm text-gray-400">
          Type a video title, a creator&apos;s name, or a tag into the box at the top
          of the page.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-panel flex items-center justify-center px-6 py-16 text-gray-400" role="status">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Searching for “{query}”…
      </div>
    );
  }

  if (failed) {
    return (
      <div className="glass-panel px-6 py-20 text-center">
        <h1 className="text-lg font-semibold text-white">
          Search is not available right now
        </h1>
        <p className="mt-2 text-sm text-gray-400">
          The results could not be loaded. Try again in a moment.
        </p>
      </div>
    );
  }

  const nothing = videos.length === 0 && creators.length === 0;

  return (
    <>
      <h1 className="text-2xl font-bold text-white">
        Results for “{query}”
      </h1>

      <p className="mt-1 text-sm text-gray-400">
        {videos.length} video{videos.length === 1 ? "" : "s"} · {creators.length} creator
        {creators.length === 1 ? "" : "s"}
      </p>

      {/* Filters narrow the videos list, and only the videos list. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="search-duration">
          Duration
        </label>
        <select
          id="search-duration"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="glass-surface rounded-full px-3 py-2 text-sm text-white"
        >
          <option value="">Any length</option>
          <option value="short">Under 5 min</option>
          <option value="medium">5–20 min</option>
          <option value="long">Over 20 min</option>
        </select>

        {allVideosFree !== true && (
          <>
            <label className="sr-only" htmlFor="search-price">
              Price
            </label>
            <select
              id="search-price"
              value={priceBand}
              onChange={(e) => setPriceBand(e.target.value)}
              className="glass-surface rounded-full px-3 py-2 text-sm text-white"
            >
              <option value="">Any price</option>
              <option value="free">Free only</option>
              <option value="under2000">Under TZS 2,000</option>
              <option value="under5000">Under TZS 5,000</option>
              <option value="under10000">Under TZS 10,000</option>
            </select>
          </>
        )}

        <button
          type="button"
          onClick={() => setVerifiedOnly((v) => !v)}
          aria-pressed={verifiedOnly}
          className={`rounded-full px-3 py-2 text-sm transition ${
            verifiedOnly
              ? "border border-violet-500/60 bg-violet-600/25 text-violet-200"
              : "glass-surface text-gray-300 hover:bg-white/10"
          }`}
        >
          Verified creators
        </button>

        {(duration || priceBand || verifiedOnly) && (
          <button
            type="button"
            onClick={() => {
              setDuration("");
              setPriceBand("");
              setVerifiedOnly(false);
            }}
            className="rounded-full px-3 py-2 text-sm text-gray-400 underline hover:text-white"
          >
            Clear filters
          </button>
        )}
      </div>

      {nothing && (
        <div className="glass-panel mt-6 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold text-white">Nothing matched</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
            Try a shorter word, check the spelling, or browse by category instead.
          </p>
          <Link href="/browse/all" className="btn-brand mt-6 inline-flex">
            Browse all videos
          </Link>
        </div>
      )}

      {creators.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-lg font-semibold text-white">Creators</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {creators.map((creator) => (
              <Link
                key={creator.id}
                href={`/creator/${creator.id}`}
                className="glass-surface group flex items-center gap-3 p-3 transition hover:border-brand-500/40 hover:bg-white/10"
              >
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full glass-surface">
                  {creator.avatarUrl ? (
                    <Image
                      src={creator.avatarUrl}
                      alt={displayHandle(creator, "Creator")}
                      fill
                      sizes="48px"
                      className="object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-sm font-bold text-gray-300">
                      {(creator.username || creator.displayName || "?").charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="flex items-center gap-1 truncate text-sm font-medium text-white">
                    {displayHandle(creator, "Unnamed creator")}
                    {creator.isVerified && <VerifiedBadge className="h-5 w-5" />}
                  </p>
                  <p className="truncate text-xs text-gray-400">
                    {typeof creator.videoCount === "number"
                      ? `${creator.videoCount} video${creator.videoCount === 1 ? "" : "s"}`
                      : "View profile"}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-white">Videos</h2>
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {videos.map((video) => (
              <VideoCard
                key={video.id}
                id={video.id}
                title={video.title}
                slug={video.slug}
                thumbnailUrl={video.thumbnailUrl}
                teaserUrl={video.teaserUrl}
                price={video.price}
                duration={video.duration}
                viewsCount={video.viewsCount}
                teaserDuration={video.teaserDuration}
                likesCount={video.likesCount}
                isPremium={video.isPremium}
                creator={video.creator}
                createdAt={video.createdAt}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
