"use client";

// =============================================================================
// GENHUB - Creator Directory (public A-Z listing)
// =============================================================================

import { useState, useEffect } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import { Search, Users, BadgeCheck, Film, UserPlus, Crown } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

interface DirectoryCreator {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  createdAt: string;
  creatorProfile: {
    bio: string | null;
    subscriptionPrice: number | null;
    totalSubscribers: number;
  } | null;
  _count: { videos: number; subscriberOf: number };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export default function CreatorDirectoryPage() {
  const [creators, setCreators] = useState<DirectoryCreator[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [letter, setLetter] = useState("");
  const { theme } = useTheme();
  const isLight = theme === "light";

  useEffect(() => {
    const timer = setTimeout(fetchCreators, query ? 300 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function fetchCreators() {
    try {
      const params = new URLSearchParams({ limit: "60" });
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/creators?${params}`);
      const data = await res.json();
      if (data.success) setCreators(data.data.creators || []);
      else setCreators([]);
    } catch {
      setCreators([]);
    } finally {
      setLoading(false);
    }
  }

  const filtered = creators.filter((c) =>
    letter ? (c.displayName || "").toUpperCase().startsWith(letter) : true
  );

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Users className="w-7 h-7 text-brand-400" />
          <div>
            <h1 className="text-2xl font-display font-bold">Creators</h1>
            <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
              Browse every creator on Genhub — find your next favorite
            </p>
          </div>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search creators…"
            className="input-field pl-10"
          />
        </div>

        {/* A-Z filter */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setLetter("")}
            className={cn(
              "w-8 h-8 rounded-lg text-xs font-bold transition",
              letter === ""
                ? "bg-brand-500 text-white"
                : isLight
                ? "bg-white border border-gray-200 text-gray-500 hover:border-brand-300"
                : "bg-surface-400/60 text-white/50 hover:text-white"
            )}
          >
            All
          </button>
          {LETTERS.map((l) => {
            const has = creators.some((c) => (c.displayName || "").toUpperCase().startsWith(l));
            return (
              <button
                key={l}
                disabled={!has && letter !== l}
                onClick={() => setLetter(l)}
                className={cn(
                  "w-8 h-8 rounded-lg text-xs font-bold transition",
                  letter === l
                    ? "bg-brand-500 text-white"
                    : has
                    ? isLight
                      ? "bg-white border border-gray-200 text-gray-500 hover:border-brand-300"
                      : "bg-surface-400/60 text-white/50 hover:text-white"
                    : "opacity-30 cursor-not-allowed bg-surface-400/30 text-white/30"
                )}
              >
                {l}
              </button>
            );
          })}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-40 rounded-2xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <UserPlus className={cn("w-16 h-16 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/10")} />
            <h3 className={cn("text-lg font-medium mb-2", isLight ? "text-gray-600" : "text-white/60")}>
              No creators found
            </h3>
            <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
              {query ? "Try a different search." : "Be the first — create a creator account!"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((c) => (
              <Link
                key={c.id}
                href={`/creator/${c.id}`}
                className={cn(
                  "rounded-2xl p-5 border transition hover:border-brand-500/40 hover:-translate-y-0.5",
                  isLight
                    ? "bg-white border-gray-200 hover:shadow-lg hover:shadow-brand-500/10"
                    : "bg-surface-400/40 border-white/5"
                )}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-brand-400/30 to-brand-600/30 flex items-center justify-center text-brand-400 font-bold text-lg shrink-0">
                    {c.displayName?.[0] || "C"}
                  </div>
                  <div className="min-w-0">
                    <p className={cn("font-medium flex items-center gap-1.5", isLight ? "text-gray-900" : "text-white")}>
                      <span className="truncate">{c.displayName || "Creator"}</span>
                      {c.isVerified && <BadgeCheck className="w-4 h-4 text-brand-400 shrink-0" />}
                    </p>
                    <p className={cn("text-xs flex items-center gap-1", isLight ? "text-gray-400" : "text-white/40")}>
                      <Film className="w-3 h-3" /> {c._count.videos} video{c._count.videos === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>

                {c.creatorProfile?.bio && (
                  <p className={cn("text-xs line-clamp-2 mb-3", isLight ? "text-gray-500" : "text-white/50")}>
                    {c.creatorProfile.bio}
                  </p>
                )}

                <div className="flex items-center justify-between text-xs">
                  <span className={cn("flex items-center gap-1", isLight ? "text-gray-400" : "text-white/40")}>
                    <Users className="w-3 h-3" /> {c._count.subscriberOf.toLocaleString()} subscribers
                  </span>
                  {c.creatorProfile?.subscriptionPrice != null && (
                    <span className="flex items-center gap-1 text-amber-400 font-medium">
                      <Crown className="w-3 h-3" /> TZS {c.creatorProfile.subscriptionPrice.toLocaleString()}/mo
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
