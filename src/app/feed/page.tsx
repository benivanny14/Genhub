"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import VideoCard from "@/components/VideoCard";
import { Users, UserPlus, Sparkles, Send, BadgeCheck } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn, formatRelativeTime } from "@/lib/utils";
import { DEMO_VIDEOS } from "@/lib/demo-data";
import { demoDataEnabled } from "@/lib/demo-mode";

interface FeedVideo {
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

interface FeedCreator {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified?: boolean;
}

interface FeedPost {
  id: string;
  body: string;
  imageUrl: string | null;
  createdAt: string;
  creator: FeedCreator;
}

export default function FeedPage() {
  const { toast } = useToast();
  const [user, setUser] = useState<{ id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creators, setCreators] = useState<FeedCreator[]>([]);
  const [videos, setVideos] = useState<FeedVideo[]>([]);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [newPost, setNewPost] = useState("");
  const [posting, setPosting] = useState(false);
  const { theme } = useTheme();
  const isLight = theme === "light";

  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch("/api/subscriptions/feed");
      const data = await res.json();
      if (data.success) {
        setCreators(data.data.creators || []);
        setVideos(data.data.videos || []);
        setPosts(data.data.posts || []);
        setDemoMode(false);
        return;
      }
    } catch {}
    // Database unreachable. In development the demo scenes keep the page
    // explorable and `demoMode` labels them; in production an unreachable feed
    // shows as empty, because 24 invented scenes with a "demo" badge is still a
    // homepage telling a visitor the platform has content it does not have.
    const demo = demoDataEnabled();
    setCreators([]);
    setVideos(demo ? (DEMO_VIDEOS as unknown as FeedVideo[]) : []);
    setPosts([]);
    setDemoMode(demo);
  }, []);

  const init = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) {
        // Definitively signed out
        setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setUser(data.data);
        setUserRole(data.data.role || null);
      } else {
        // Authenticated cookie but profile fetch failed (e.g. DB hiccup)
        setUser({ id: "" });
      }
      await fetchFeed();
    } catch {
      // Server unreachable — leave signed-out state
    }
    setLoading(false);
  }, [fetchFeed]);

  useEffect(() => {
    init();
  }, [init]);

  async function publishPost() {
    if (!newPost.trim() || posting) return;
    setPosting(true);
    try {
      const res = await fetch("/api/creator/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newPost.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setPosts((prev) => [data.data, ...prev]);
        setNewPost("");
      } else {
        toast("error", data.error || "Could not publish post");
      }
    } catch {
      toast("error", "Network error");
    } finally {
      setPosting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-48 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <Users className="w-7 h-7 text-brand-400" />
          <div>
            <h1 className="text-2xl font-display font-bold">Following</h1>
            <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
              Latest posts from creators you subscribe to
            </p>
          </div>
        </div>

        {/* Not logged in */}
        {!user ? (
          <div className={cn(
            "rounded-2xl p-10 text-center border",
            isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
          )}>
            <UserPlus className={cn("w-12 h-12 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/20")} />
            <h2 className={cn("text-xl font-display font-bold mb-2", isLight ? "text-gray-900" : "text-white")}>
              Sign in to see your feed
            </h2>
            <p className={cn("text-sm mb-6", isLight ? "text-gray-500" : "text-white/50")}>
              Subscribe to creators and their newest videos will appear here.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href="/login" className="btn-ghost">Sign In</Link>
              <Link href="/register" className="btn-brand">Create Account</Link>
            </div>
          </div>
        ) : (
          <>
            {/* Subscribed creators chips */}
            {creators.length > 0 && (
              <div className="flex gap-3 overflow-x-auto pb-2">
                {creators.map((c) => (
                  <Link
                    key={c.id}
                    href={`/creator/${c.id}`}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-full border whitespace-nowrap transition",
                      isLight
                        ? "bg-white border-gray-200 hover:border-brand-300"
                        : "bg-surface-400/60 border-white/10 hover:border-brand-500/40"
                    )}
                  >
                    <div className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 text-xs font-bold">
                      {c.displayName?.[0] || "C"}
                    </div>
                    <span className={cn("text-sm", isLight ? "text-gray-700" : "text-white/80")}>
                      {c.displayName || "Creator"}
                    </span>
                  </Link>
                ))}
              </div>
            )}

            {/* Composer (creators only) */}
            {userRole === "CREATOR" && (
              <div className={cn(
                "rounded-2xl p-4 border",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}>
                <textarea
                  value={newPost}
                  onChange={(e) => setNewPost(e.target.value)}
                  placeholder="Share an update with your subscribers…"
                  rows={3}
                  maxLength={1000}
                  className="input-field resize-none"
                />
                <div className="flex justify-between items-center mt-2">
                  <span className={cn("text-xs", isLight ? "text-gray-400" : "text-white/30")}>
                    {newPost.length}/1000
                  </span>
                  <button
                    onClick={publishPost}
                    disabled={posting || !newPost.trim()}
                    className="btn-brand text-sm px-4 py-2 flex items-center gap-2 disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" /> {posting ? "Posting…" : "Post"}
                  </button>
                </div>
              </div>
            )}

            {/* Timeline posts */}
            {posts.length > 0 && (
              <div className="space-y-4">
                {posts.map((post) => (
                  <article
                    key={post.id}
                    className={cn(
                      "rounded-2xl p-5 border",
                      isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
                    )}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <Link href={`/creator/${post.creator.id}`} className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold shrink-0">
                          {post.creator.displayName?.[0] || "C"}
                        </div>
                        <div className="min-w-0">
                          <p className={cn(
                            "font-medium text-sm flex items-center gap-1.5",
                            isLight ? "text-gray-900" : "text-white"
                          )}>
                            <span className="truncate">{post.creator.displayName || "Creator"}</span>
                            {post.creator.isVerified && (
                              <BadgeCheck className="w-4 h-4 text-brand-400 shrink-0" />
                            )}
                          </p>
                          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
                            {formatRelativeTime(new Date(post.createdAt))}
                          </p>
                        </div>
                      </Link>
                    </div>
                    <p className={cn(
                      "text-sm whitespace-pre-wrap",
                      isLight ? "text-gray-700" : "text-white/80"
                    )}>
                      {post.body}
                    </p>
                  </article>
                ))}
              </div>
            )}

            {/* Demo banner */}
            {demoMode && (
              <div className={cn(
                "rounded-xl px-4 py-3 text-sm border",
                isLight
                  ? "bg-amber-50 text-amber-700 border-amber-100"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/20"
              )}>
                Demo data is showing — connect a database and subscribe to creators to personalize this feed.
              </div>
            )}

            {/* Empty state */}
            {!demoMode && videos.length === 0 && (
              <div className={cn(
                "rounded-2xl p-10 text-center border",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}>
                <Sparkles className={cn("w-12 h-12 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/20")} />
                <h2 className={cn("text-xl font-display font-bold mb-2", isLight ? "text-gray-900" : "text-white")}>
                  Your feed is empty
                </h2>
                <p className={cn("text-sm mb-6", isLight ? "text-gray-500" : "text-white/50")}>
                  Subscribe to creators to see their newest uploads here first.
                </p>
                <Link href="/" className="btn-brand inline-flex">Discover Creators</Link>
              </div>
            )}

            {/* Video grid */}
            {videos.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {videos.map((video) => (
                  <VideoCard key={video.id} {...video} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
