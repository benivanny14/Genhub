"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import VideoCard from "@/components/VideoCard";
import { Heart, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

interface FavoriteItem {
  video: {
    id: string;
    title: string;
    slug: string | null;
    thumbnailUrl: string | null;
    price: number;
    viewsCount: number;
    teaserDuration: number;
    duration: number | null;
    createdAt: string;
    creator: {
      id: string;
      displayName: string | null;
      avatarUrl: string | null;
    };
  };
}

export default function FavoritesPage() {
  const router = useRouter();
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { theme } = useTheme();
  const isLight = theme === "light";

  const fetchFavorites = useCallback(async () => {
    try {
      const res = await fetch("/api/favorites");
      const data = await res.json();
      if (data.success) {
        setFavorites(data.data);
      } else {
        router.push("/login");
      }
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchFavorites();
  }, [fetchFavorites]);

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <h1 className={cn("text-2xl font-display font-bold flex items-center gap-3 mb-6", isLight && "text-gray-900")}>
          <Heart className="w-6 h-6 text-red-400" /> Saved Videos
        </h1>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="skeleton aspect-video" />
                <div className="skeleton h-4 w-3/4" />
              </div>
            ))}
          </div>
        ) : favorites.length === 0 ? (
          <div className="text-center py-20">
            <Play className={cn("w-16 h-16 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/10")} />
            <h3 className={cn("text-lg font-medium mb-2", isLight ? "text-gray-500" : "text-white/60")}>No saved videos</h3>
            <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>Tap the bookmark icon on any video to save it here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-6">
            {favorites.map((fav) => (
              <VideoCard
                key={fav.video.id}
                {...fav.video}
                creator={fav.video.creator}
                createdAt={fav.video.createdAt}
                teaserDuration={fav.video.teaserDuration}
              />
            ))}
          </div>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
