"use client";

// =============================================================================
// GENHUB - Playlists page
// Watch Later + user playlists in one place: pick a list on the left, manage
// its videos on the right. Create, rename and delete keep everything tidy.
// =============================================================================

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import VideoCard from "@/components/VideoCard";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import {
  ListVideo,
  Plus,
  Trash2,
  X,
  Loader2,
  Bookmark,
  Play,
} from "lucide-react";

interface PlaylistSummary {
  id: string;
  name: string;
  isWatchLater: boolean;
  itemCount: number;
}

interface PlaylistVideo {
  id: string;
  itemId: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  teaserDuration: number;
  duration: number | null;
  viewsCount: number;
  createdAt: string;
  creator: { id: string; displayName: string | null; avatarUrl: string | null };
}

export default function PlaylistsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { theme } = useTheme();
  const isLight = theme === "light";

  const [loading, setLoading] = useState(true);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [videos, setVideos] = useState<PlaylistVideo[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // Deleting a playlist is irreversible, so it asks for confirmation in an
  // in-app dialog instead of a native window.confirm.
  const [pendingDelete, setPendingDelete] = useState<PlaylistSummary | null>(null);

  useEffect(() => {
    loadPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) loadVideos(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function loadPlaylists() {
    try {
      const res = await fetch("/api/playlists");
      const data = await res.json();
      if (!data.success) {
        router.push("/login");
        return;
      }
      const list: PlaylistSummary[] = data.data || [];
      setPlaylists(list);
      if (list.length > 0) setSelectedId((prev) => prev ?? list[0].id);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  async function loadVideos(playlistId: string) {
    setLoadingVideos(true);
    try {
      const res = await fetch(`/api/playlists/${playlistId}`);
      const data = await res.json();
      if (data.success) setVideos(data.data.videos || []);
    } catch {
      toast("error", "Could not load this playlist");
    } finally {
      setLoadingVideos(false);
    }
  }

  async function createPlaylist() {
    const name = newName.trim();
    if (name.length < 2) {
      toast("warning", "Playlist name needs at least 2 characters");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not create the playlist");
        return;
      }
      setPlaylists((prev) => [...prev, data.data]);
      setSelectedId(data.data.id);
      setNewName("");
      toast("success", "Playlist created");
    } catch {
      toast("error", "Could not create the playlist");
    } finally {
      setBusy(false);
    }
  }

  async function removeVideo(video: PlaylistVideo) {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/playlists/${selectedId}/items?videoId=${video.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        setVideos((prev) => prev.filter((v) => v.id !== video.id));
        setPlaylists((prev) =>
          prev.map((p) => (p.id === selectedId ? { ...p, itemCount: Math.max(0, p.itemCount - 1) } : p))
        );
        toast("success", "Removed from playlist");
      } else {
        toast("error", data.error || "Could not remove the video");
      }
    } catch {
      toast("error", "Could not remove the video");
    } finally {
      setBusy(false);
    }
  }

  async function deletePlaylist(playlist: PlaylistSummary) {
    if (playlist.isWatchLater) return;
    setPendingDelete(null);

    setBusy(true);
    try {
      const res = await fetch(`/api/playlists/${playlist.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        const remaining = playlists.filter((p) => p.id !== playlist.id);
        setPlaylists(remaining);
        if (selectedId === playlist.id) {
          setSelectedId(remaining[0]?.id ?? null);
          if (remaining.length === 0) setVideos([]);
        }
        toast("success", "Playlist deleted");
      } else {
        toast("error", data.error || "Could not delete the playlist");
      }
    } catch {
      toast("error", "Could not delete the playlist");
    } finally {
      setBusy(false);
    }
  }

  const muted = isLight ? "text-gray-500" : "text-white/50";
  const heading = isLight ? "text-gray-900" : "text-white";

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <h1 className={cn("text-2xl font-display font-bold flex items-center gap-3 mb-6", heading)}>
          <ListVideo className="w-6 h-6 text-brand-400" /> My Playlists
        </h1>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Sidebar */}
          <aside className="space-y-4 lg:col-span-1">
            <div
              className={cn(
                "glass-card p-3 space-y-1",
                isLight && "bg-white/70 border-gray-200/60"
              )}
            >
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skeleton h-10 rounded-xl" />
                  ))}
                </div>
              ) : playlists.length === 0 ? (
                <p className={cn("text-sm p-3", muted)}>No playlists yet.</p>
              ) : (
                playlists.map((p) => (
                  <div key={p.id} className="group flex items-center">
                    <button
                      onClick={() => setSelectedId(p.id)}
                      className={cn(
                        "flex-1 flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-sm text-left transition",
                        selectedId === p.id
                          ? "bg-brand-500/20 text-brand-300"
                          : isLight
                            ? "hover:bg-gray-100 text-gray-700"
                            : "hover:bg-white/5 text-white/70"
                      )}
                    >
                      <span className="flex items-center gap-2 truncate">
                        {p.isWatchLater ? (
                          <Bookmark className="w-4 h-4 shrink-0" />
                        ) : (
                          <ListVideo className="w-4 h-4 shrink-0" />
                        )}
                        <span className="truncate">{p.name}</span>
                      </span>
                      <span className={cn("text-xs shrink-0", muted)}>{p.itemCount}</span>
                    </button>
                    {!p.isWatchLater && (
                      <button
                        onClick={() => setPendingDelete(p)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition"
                        title="Delete playlist"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* New playlist */}
            <div className="glass-card p-3 flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createPlaylist()}
                placeholder="New playlist"
                className={cn(
                  "flex-1 min-w-0 border rounded-xl px-3 py-2 text-sm outline-none focus:border-brand-500",
                  isLight
                    ? "bg-white border-gray-200 text-gray-900"
                    : "bg-surface-400/60 border-white/10 text-white"
                )}
              />
              <button
                onClick={createPlaylist}
                disabled={busy}
                className="btn-brand px-3 shrink-0 disabled:opacity-50"
                aria-label="Create playlist"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </button>
            </div>
          </aside>

          {/* Videos */}
          <section className="lg:col-span-3">
            {loadingVideos ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="space-y-3">
                    <div className="skeleton aspect-video" />
                    <div className="skeleton h-4 w-3/4" />
                  </div>
                ))}
              </div>
            ) : videos.length === 0 ? (
              <div className="text-center py-20">
                <Play className={cn("w-14 h-14 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/10")} />
                <h3 className={cn("text-lg font-medium mb-2", heading)}>Nothing here yet</h3>
                <p className={cn("text-sm", muted)}>
                  Use “Watch Later” or “Add to playlist” on any video to fill this list.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-6">
                {videos.map((video) => (
                  <div key={video.itemId} className="relative group/item">
                    <VideoCard
                      id={video.id}
                      title={video.title}
                      slug={video.slug}
                      thumbnailUrl={video.thumbnailUrl}
                      price={video.price}
                      teaserDuration={video.teaserDuration}
                      duration={video.duration}
                      viewsCount={video.viewsCount}
                      createdAt={video.createdAt}
                      creator={video.creator}
                    />
                    <button
                      onClick={() => removeVideo(video)}
                      disabled={busy}
                      className="absolute top-2 right-2 z-10 p-1.5 rounded-full bg-black/70 backdrop-blur text-white/80 hover:text-red-400 opacity-0 group-hover/item:opacity-100 transition disabled:opacity-50"
                      title="Remove from playlist"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
      <BottomNav />

      {/* Delete confirmation */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className={cn(
              "w-full max-w-sm rounded-2xl p-6 animate-slide-up",
              isLight ? "bg-white" : "glass-card"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Trash2 className="w-5 h-5 text-red-400" />
                <h2 className={cn("font-display font-bold", heading)}>Delete this playlist?</h2>
              </div>
              <button
                onClick={() => setPendingDelete(null)}
                aria-label="Close"
                className={cn("p-1 rounded-lg", muted)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className={cn("text-sm mt-3", muted)}>
              &ldquo;{pendingDelete.name}&rdquo; and its list will be removed. The videos stay on
              Genhub and in your history.
            </p>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setPendingDelete(null)} className="btn-ghost flex-1">
                Keep it
              </button>
              <button
                onClick={() => deletePlaylist(pendingDelete)}
                className="btn-brand flex-1 bg-red-500 hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
