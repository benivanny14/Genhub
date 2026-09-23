"use client";

// =============================================================================
// GENHUB - Shared infinite-scroll video feed hook
// One tested implementation of paging, dedupe, retry and reset used by both
// the homepage grid and /browse/[category] pages.
//
// Behavior:
//   * Changing the query (q/category/sort/duration/date/pageSize) resets to
//     page 1 and refetches — no stale-closure page bugs.
//   * Stale responses (from a previous query) are dropped via a generation
//     counter.
//   * Appends deduplicate by id, so overlapping pages never duplicate cards.
//   * An optional `fallback` supplies demo data when the API is unreachable
//     or the database is empty (local dev without a DB).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";

export interface InfiniteVideoQuery {
  q?: string;
  category?: string;
  sort?: string;
  duration?: string;
  date?: string;
  pageSize?: number;
}

export interface VideoPageResult<T> {
  videos: T[];
  totalPages: number;
  /** Total matching items across all pages (from API pagination) */
  total?: number;
}

/** Stable serialization of the query — the reset/refetch key. */
export function videoQueryKey(query: InfiniteVideoQuery): string {
  return JSON.stringify([
    query.q || "",
    query.category || "",
    query.sort || "newest",
    query.duration || "",
    query.date || "",
    query.pageSize || 20,
  ]);
}

/** Append with dedupe by id (replace discards the previous list entirely). */
export function mergeVideos<T extends { id: string }>(
  prev: T[],
  incoming: T[],
  replace: boolean
): T[] {
  const base = replace ? [] : prev;
  const seen = new Set(base.map((v) => v.id));
  const merged = [...base];
  for (const video of incoming) {
    if (!seen.has(video.id)) {
      seen.add(video.id);
      merged.push(video);
    }
  }
  return merged;
}

/** Fetch one page from /api/videos. Throws on API/network failure. */
export async function fetchVideoPage<T>(
  query: InfiniteVideoQuery,
  page: number,
  fetchImpl: typeof fetch = fetch
): Promise<VideoPageResult<T>> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(query.pageSize ?? 20),
    sort: query.sort || "newest",
  });
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.duration) params.set("duration", query.duration);
  if (query.date) params.set("date", query.date);

  const res = await fetchImpl(`/api/videos?${params.toString()}`);
  const data = await res.json();

  if (!data.success || !Array.isArray(data?.data?.videos)) {
    throw new Error(data?.error || "Failed to load videos");
  }
  return {
    videos: data.data.videos as T[],
    totalPages: data?.data?.pagination?.totalPages ?? 1,
    total: data?.data?.pagination?.total ?? 0,
  };
}

export function useInfiniteVideos<T extends { id: string }>(
  query: InfiniteVideoQuery,
  fallback?: (page: number) => VideoPageResult<T> | null
) {
  const key = videoQueryKey(query);

  const [videos, setVideos] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const generation = useRef(0);
  const queryRef = useRef(query);
  const fallbackRef = useRef(fallback);
  queryRef.current = query;
  fallbackRef.current = fallback;

  const load = useCallback(
    async (targetPage: number, replace: boolean, gen: number) => {
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError("");
      try {
        let result: VideoPageResult<T>;
        try {
          result = await fetchVideoPage<T>(queryRef.current, targetPage);
          // Empty page 1 + a fallback configured => use demo data (dev without DB)
          if (result.videos.length === 0 && targetPage === 1 && fallbackRef.current) {
            const fb = fallbackRef.current(targetPage);
            if (fb) result = fb;
          }
        } catch (fetchError) {
          const fb = fallbackRef.current?.(targetPage) ?? null;
          if (!fb) throw fetchError;
          result = fb;
        }

        if (gen !== generation.current) return; // stale query — drop
        setVideos((prev) => mergeVideos(prev, result.videos, replace));
        setTotalPages(result.totalPages);
        setTotal(result.total ?? 0);
        setPage(targetPage);
      } catch (e: any) {
        if (gen !== generation.current) return;
        setError(e?.message || "Failed to load videos");
      } finally {
        if (gen === generation.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  // Reset + refetch whenever the query changes (including the first mount)
  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    setVideos([]);
    setPage(1);
    setTotalPages(1);
    setTotal(0);
    load(1, true, gen);
  }, [key, load]);

  const hasMore = page < totalPages;

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const next = page + 1;
    setPage(next);
    load(next, false, generation.current);
  }, [loading, loadingMore, hasMore, page, load]);

  /** Force a refetch of page 1 (e.g. search submit with an unchanged value). */
  const reload = useCallback(() => {
    generation.current += 1;
    const gen = generation.current;
    setVideos([]);
    setPage(1);
    load(1, true, gen);
  }, [load]);

  return {
    videos,
    page,
    totalPages,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    reload,
  };
}
