"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import Header from "@/components/Header";
// hls.js inside VideoPlayer is heavy — load it after hydration so the initial
// route JS stays small (player mounts with a skeleton placeholder).
const VideoPlayer = dynamic(() => import("@/components/VideoPlayer"), {
  ssr: false,
  loading: () => <div className="skeleton aspect-video rounded-xl" />,
});
import { formatTZS, formatCount, formatRelativeTime } from "@/lib/utils";
import {
  Play,
  Eye,
  Calendar,
  Flag,
  Heart,
  MessageCircle,
  Share2,
  Shield,
  ArrowLeft,
  Gift,
  ThumbsUp,
  ThumbsDown,
  Ticket,
  Smartphone,
  Wallet,
  Bookmark,
  BookmarkCheck,
  ListPlus,
  Images,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Loader2,
  Hourglass,
  ReceiptText,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { DEMO_VIDEOS } from "@/lib/demo-data";
import { demoDataEnabled } from "@/lib/demo-mode";
// Comments render below the fold — split them out of the initial bundle too
const CommentsSection = dynamic(() => import("@/components/CommentsSection"), {
  ssr: false,
  loading: () => <div className="skeleton h-32 w-full rounded-xl" />,
});
import { useToast } from "@/components/Toast";
import { useCurrency } from "@/lib/currency";

interface VideoData {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  price: number;
  teaserDuration: number;
  duration: number | null;
  viewsCount: number;
  likesCount: number;
  dislikesCount?: number;
  purchaseCount: number;
  category: string | null;
  tags: string[];
  createdAt: string;
  hasAccess: boolean;
  accessSource?: "free" | "purchase" | "entitlement" | null;
  /** Set when a charge for this video was approved but never settled. */
  paymentUnderInvestigation?: {
    transactionId: string;
    providerRef: string | null;
    amount: number;
    createdAt: string;
  } | null;
  playbackUrl: string | null;
  teaserUrl: string | null;
  /**
   * Bunny's processing state. `ready` and `untracked` mean nothing blocks
   * playback; `pending`/`processing` mean the bytes are not servable yet, and
   * `failed` means they never will be.
   */
  encoding?: {
    state: "pending" | "processing" | "ready" | "failed" | "untracked";
    status: number | null;
    progress: number;
    label: string;
    error: string | null;
  };
  galleryImages?: { id: string; url: string; position: number }[];
  creator: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

interface User {
  id: string;
  role: string;
  displayName?: string;
  phone?: string;
  walletBalance?: number;
}

interface RelatedVideo {
  id: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  viewsCount: number;
  category: string | null;
  createdAt: string;
  creator: { id: string; displayName: string | null };
}

interface PlaylistSummary {
  id: string;
  name: string;
  isWatchLater: boolean;
  itemCount: number;
}

const REPORT_REASONS = [
  "DMCA",
  "INAPPROPRIATE",
  "SPAM",
  "VIOLENCE",
  "OTHER",
] as const;

type ReportReason = (typeof REPORT_REASONS)[number];

const REPORT_LABELS: Record<ReportReason, string> = {
  DMCA: "Copyright (DMCA)",
  INAPPROPRIATE: "Inappropriate content",
  SPAM: "Spam or scam",
  VIOLENCE: "Violence",
  OTHER: "Something else",
};

export default function VideoDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const [video, setVideo] = useState<VideoData | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponError, setCouponError] = useState("");
  const [related, setRelated] = useState<RelatedVideo[]>([]);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [likesCount, setLikesCount] = useState(0);
  const [dislikesCount, setDislikesCount] = useState(0);
  const [isDemo, setIsDemo] = useState(false);
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipAmount, setTipAmount] = useState("1000");
  const [tipMessage, setTipMessage] = useState("");
  const [tipping, setTipping] = useState(false);
  const [startAt, setStartAt] = useState(0);
  // Library state: Watch Later bookmark, playlists picker, gallery lightbox
  const [inWatchLater, setInWatchLater] = useState(false);
  const [watchLaterBusy, setWatchLaterBusy] = useState(false);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const { toast } = useToast();
  const { format } = useCurrency();

  // ===========================================================================
  // Library: Watch Later + playlists
  // ===========================================================================

  useEffect(() => {
    if (!user || !video) return;
    let cancelled = false;

    (async () => {
      try {
        const [wl, pl] = await Promise.all([
          fetch("/api/watch-later").then((r) => r.json()),
          fetch("/api/playlists").then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (wl?.success) {
          setInWatchLater((wl.data.videoIds || []).includes(video.id));
        }
        if (pl?.success) {
          setPlaylists((pl.data || []).filter((p: PlaylistSummary) => !p.isWatchLater));
        }
      } catch {
        // Library state is a nicety — never block the page on it
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, video?.id]);

  async function toggleWatchLater() {
    if (!user) {
      router.push("/login");
      return;
    }
    if (!video) return;

    setWatchLaterBusy(true);
    try {
      const res = await fetch("/api/watch-later", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id }),
      });
      const data = await res.json();
      if (data.success) {
        setInWatchLater(data.data.added);
        toast("success", data.message);
      } else {
        toast("error", data.error || "Something went wrong");
      }
    } catch {
      toast("error", "Could not save");
    } finally {
      setWatchLaterBusy(false);
    }
  }

  async function addToPlaylist(playlistId: string) {
    if (!video) return;
    setPlaylistBusy(true);
    try {
      const res = await fetch(`/api/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id }),
      });
      const data = await res.json();
      toast(data.success ? "success" : "error", data.message || data.error);
      if (data.success) setShowPlaylistModal(false);
    } catch {
      toast("error", "Could not add to the playlist");
    } finally {
      setPlaylistBusy(false);
    }
  }

  async function createPlaylist() {
    const name = newPlaylistName.trim();
    if (name.length < 2) {
      toast("warning", "A playlist name must be at least 2 characters");
      return;
    }

    setPlaylistBusy(true);
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
      setNewPlaylistName("");
      await addToPlaylist(data.data.id);
    } catch {
      toast("error", "Could not create the playlist");
    } finally {
      setPlaylistBusy(false);
    }
  }

  // Escape closes the gallery lightbox (image-viewer convention)
  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIndex(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightboxIndex]);

  // ===========================================================================
  // Members-only download
  // ===========================================================================

  async function handleDownload(quality: string = "1080p") {
    if (!video) return;
    if (!user) {
      router.push("/login");
      return;
    }

    setDownloading(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/download?quality=${quality}`);
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not download");
        return;
      }
      window.open(data.data.url, "_blank", "noopener,noreferrer");
      toast("success", `Inapakua ${data.data.fileName}`);
    } catch {
      toast("error", "Could not download");
    } finally {
      setDownloading(false);
    }
  }

  async function handleShare() {
    if (!video) return;
    const url = typeof window !== "undefined" ? window.location.href : "";

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: video.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast("success", "Kiungo kimekopiwa");
    } catch {
      toast("error", "Could not share");
    }
  }

  async function previewPurchaseCoupon() {
    setCouponError("");
    setCouponDiscount(0);
    if (!couponCode.trim() || !video) return;
    try {
      const res = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: couponCode.trim(),
          amount: video.price,
          context: "purchase",
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCouponDiscount(data.data.discount || 0);
      } else {
        setCouponError(data.error || "Invalid coupon");
      }
    } catch {
      setCouponError("Could not check coupon");
    }
  }

  useEffect(() => {
    if (video) fetchRelated(video);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id]);

  useEffect(() => {
    if (video && !isDemo) fetchInteractions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, isDemo]);

  // Resume position for partially watched videos
  useEffect(() => {
    if (!video || !user || isDemo) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/videos/${video.id}/progress`);
        const data = await res.json();
        if (!cancelled && data.success) {
          setStartAt(data.data.positionSeconds || 0);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
    // Only the ids matter: depending on the whole objects would refetch the
    // saved position every time the video object is replaced after a purchase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, user?.id, isDemo]);

  const fetchVideo = useCallback(async () => {
    let found = false;
    try {
      const res = await fetch(`/api/videos/${id}`);
      const data = await res.json();
      if (data.success) {
        setVideo(data.data);
        setLikesCount(data.data.likesCount || 0);
        setDislikesCount(data.data.dislikesCount || 0);
        setIsDemo(false);
        found = true;
      }
    } catch (error) {
      console.error("Failed to fetch video:", error);
    }

    // Demo fallback — lets the preview work without a connected database, in
    // development only. A launched site must not answer a failed request with a
    // scene that does not exist.
    if (!found && demoDataEnabled()) {
      const demo = DEMO_VIDEOS.find((v) => v.id === id || v.slug === id);
      if (demo) {
        setVideo(demo);
        setIsDemo(true);
        setLikesCount(demo.likesCount);
        setDislikesCount(demo.dislikesCount || 0);
      }
    }
    setLoading(false);
  }, [id]);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      if (data.success) setUser(data.data);
    } catch {}
  }, []);

  // Loads the video (or the demo fallback) and the viewer once per id.
  useEffect(() => {
    fetchVideo();
    fetchUser();
  }, [fetchVideo, fetchUser]);

  function rankRelated<T extends RelatedVideo>(pool: T[], current: RelatedVideo): T[] {
    return [...pool].sort((a, b) => score(b) - score(a));
    function score(v: T): number {
      let s = 0;
      if (v.creator.id === current.creator.id) s += 4;
      if (current.category && v.category === current.category) s += 2;
      if (v.id === current.id || (current.slug && v.slug === current.slug)) s -= 100;
      return s;
    }
  }

  async function fetchRelated(current: VideoData) {
    try {
      const res = await fetch("/api/videos?limit=20");
      const data = await res.json();
      if (data.success && Array.isArray(data.data.videos) && data.data.videos.length > 0) {
        const pool = data.data.videos as RelatedVideo[];
        setRelated(rankRelated(pool.filter((v) => v.id !== current.id), current).slice(0, 6));
        return;
      }
    } catch {}
    // Nothing real to rank. Showing demo scenes under a real video is worse than
    // showing none: these are recommendation slots, and in production they would
    // be six invented videos presented as "more like this".
    const pool = demoDataEnabled()
      ? (DEMO_VIDEOS.filter((v) => v.id !== current.id) as unknown as RelatedVideo[])
      : [];
    setRelated(pool.length > 0 ? rankRelated(pool, current).slice(0, 6) : []);
  }

  async function fetchInteractions() {
    try {
      const res = await fetch(`/api/videos/${id}/interactions`);
      const data = await res.json();
      if (data.success) {
        setLiked(!!data.data.liked);
        setDisliked(!!data.data.disliked);
        setLikesCount(data.data.likesCount || 0);
        setDislikesCount(data.data.dislikesCount || 0);
      }
    } catch {}
  }

  async function handleRate(type: "like" | "dislike") {
    if (!user) {
      toast("warning", "Sign in to rate this video");
      return;
    }

    // Snapshot for revert
    const prev = { liked, disliked, likesCount, dislikesCount };

    // Optimistic update
    if (type === "like") {
      setLikesCount((n) => (liked ? n - 1 : n + 1));
      if (disliked) setDislikesCount((n) => n - 1);
      setLiked(!liked);
      setDisliked(false);
    } else {
      setDislikesCount((n) => (disliked ? n - 1 : n + 1));
      if (liked) setLikesCount((n) => n - 1);
      setDisliked(!disliked);
      setLiked(false);
    }

    try {
      const res = await fetch(`/api/videos/${id}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      if (data.success) {
        if (typeof data.data.likesCount === "number") setLikesCount(data.data.likesCount);
        if (typeof data.data.dislikesCount === "number") setDislikesCount(data.data.dislikesCount);
      } else if (!isDemo) {
        setLiked(prev.liked);
        setDisliked(prev.disliked);
        setLikesCount(prev.likesCount);
        setDislikesCount(prev.dislikesCount);
        toast("error", data.error || "Could not save your rating");
      }
    } catch {
      if (!isDemo) {
        setLiked(prev.liked);
        setDisliked(prev.disliked);
        setLikesCount(prev.likesCount);
        setDislikesCount(prev.dislikesCount);
        toast("error", "Could not save your rating");
      }
    }
  }

  async function handleTip() {
    if (!video) return;
    if (!user) {
      toast("warning", "Sign in to send a tip");
      return;
    }
    const amt = parseInt(tipAmount);
    if (!amt || amt < 500 || amt > 100000) {
      toast("error", "Tip must be between TZS 500 and TZS 100,000");
      return;
    }
    setTipping(true);
    try {
      const res = await fetch("/api/tips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorId: video.creator.id,
          amount: amt,
          message: tipMessage.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Tip sent — thank you for the support! 🎁");
        setShowTipModal(false);
        setTipMessage("");
      } else {
        toast("error", data.error || "Could not send tip");
      }
    } catch {
      toast("error", "Could not send tip");
    } finally {
      setTipping(false);
    }
  }

  // Pay from the wallet balance instead of a USSD push. Server-side this is one
  // atomic transaction (charge + 70/30 split + unlock), so it settles instantly.
  async function handleWalletPurchase() {
    if (!video || !user) return;
    setPurchasing(true);

    try {
      const res = await fetch("/api/payments/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.id,
          method: "WALLET",
          couponCode: couponCode.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setShowPurchaseModal(false);
        toast("success", "Paid from your wallet — enjoy the full video!");
        fetchVideo();
      } else {
        toast("error", data.error || "Could not pay from your wallet");
      }
    } catch {
      toast("error", "An error occurred. Please try again.");
    } finally {
      setPurchasing(false);
    }
  }

  async function handlePurchase() {
    if (!video || !user || !phoneNumber) return;
    // Belt-and-braces: the paywall already hides the button, but a second
    // charge for a purchase that may already be paid is the one mistake this
    // state exists to prevent, so the handler refuses too.
    if (video.paymentUnderInvestigation) {
      toast(
        "warning",
        "This purchase is already being checked with your network — paying again could charge you twice."
      );
      return;
    }
    setPurchasing(true);

    try {
      const res = await fetch("/api/payments/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.id,
          gateway: "HARAKAPAY",
          phoneNumber,
          couponCode: couponCode.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (data.success && data.data?.sandbox) {
        // Local dev: no real USSD push — complete through the same webhook
        // processor production uses, then refresh access state.
        const done = await fetch("/api/dev/sandbox/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: data.data.orderId }),
        });
        const doneData = await done.json();
        if (doneData.success) {
          setShowPurchaseModal(false);
          toast("success", "Payment confirmed — enjoy the full video!");
          fetchVideo();
        } else {
          toast("error", doneData.error || "Sandbox payment failed");
        }
      } else if (data.success) {
        // Live HarakaPay: USSD push sent — poll until the gateway confirms
        setShowPurchaseModal(false);
        toast("info", "USSD push sent to your phone — enter your PIN to confirm.");
        pollPaymentStatus(data.data.transactionId);
      } else {
        toast("error", data.error || "Payment failed");
      }
    } catch {
      toast("error", "An error occurred. Please try again.");
    } finally {
      setPurchasing(false);
    }
  }

  // Poll the transaction until HarakaPay completes/fails it (webhook or reconcile)
  function pollPaymentStatus(transactionId: string, attempt = 0) {    // ~2 minutes: entering a USSD PIN can easily take a minute on a slow network.
    if (attempt >= 40) {
      toast(
        "warning",
        "Payment is still processing — refresh the page in a minute.");
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/status/${transactionId}`);
        const data = await res.json();
        if (!data.success) return;
        const status = data.data.status;
        if (status === "SUCCESS") {
          toast("success", "Payment confirmed — enjoy the full video!");
          fetchVideo();
          return;
        }
        if (status === "FAILED") {
          toast("error", "Payment failed or was cancelled. Please try again.");
          return;
        }
        if (status === "UNDER_INVESTIGATION") {
          // We cannot tell whether this customer's money moved. Stop insisting
          // they pay: the paywall switches to a "we are checking" panel.
          toast(
            "warning",
            "You approved the charge but the money has not reached us yet. We are checking with your network — please do not pay again."
          );
          fetchVideo();
          return;
        }
        pollPaymentStatus(transactionId, attempt + 1);
      } catch {
        pollPaymentStatus(transactionId, attempt + 1);
      }
    }, 3000);
  }

  // The report form lives in an in-app modal: native window.prompt is blocked
  // in some browsers and cannot offer a reason picker.
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>("DMCA");
  const [reportDescription, setReportDescription] = useState("");
  const [reporting, setReporting] = useState(false);

  async function handleReport() {
    if (!video) return;
    setReporting(true);
    try {
      const res = await fetch("/api/videos/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.id,
          reason: reportReason,
          ...(reportReason === "OTHER"
            ? { description: reportDescription.trim() }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success === false) {
        toast(
          "error",
          res.status === 401
            ? "Sign in to report this video."
            : data?.error || "Could not submit the report. Please try again."
        );
        return;
      }
      toast("success", "Report submitted. Thank you for your cooperation.");
      setShowReportModal(false);
      setReportDescription("");
    } catch {
      toast("error", "An error occurred.");
    } finally {
      setReporting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="skeleton aspect-video w-full" />
          <div className="skeleton h-8 w-2/3 mt-6" />
          <div className="skeleton h-4 w-1/3 mt-4" />
        </div>
      </div>
    );
  }

  if (!video) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <h2 className="text-xl font-medium mb-2">Video not found</h2>
            <Link href="/" className="text-brand-400 hover:underline">
              Go home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const canPlayFull = video.hasAccess || user?.role === "ADMIN";

  // A video Bunny has not finished transcoding has nothing to serve yet — not
  // the full scene, and not the teaser, since both are encoded the same way. On
  // top of that, a token signed for a video with no renditions produces a player
  // that fails after it has already filled the page, which reads as a broken
  // site rather than a video that is on its way. So say what is true instead.
  const encoding = video.encoding;
  const stillProcessing =
    encoding?.state === "pending" || encoding?.state === "processing";
  const processingFailed = encoding?.state === "failed";
  const isOwner = user?.id === video.creator.id;
  const notPlayable = stillProcessing || processingFailed;

  const videoSrc = notPlayable
    ? null
    : canPlayFull
      ? video.playbackUrl
      : video.teaserUrl;
  const totalVotes = likesCount + dislikesCount;
  const ratingPct = totalVotes > 0 ? Math.round((likesCount / totalVotes) * 100) : 100;
  const ratingLabel = totalVotes > 0 ? `${ratingPct}%` : "Rate";

  return (
    <div className="min-h-screen page-enter">
      <Header />

      {/* VideoObject structured data for SEO */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "VideoObject",
            name: video.title,
            description: video.description || video.title,
            thumbnailUrl: video.thumbnailUrl || undefined,
            uploadDate: video.createdAt,
            duration: video.duration ? `PT${video.duration}S` : undefined,
            interactionStatistic: [
              {
                "@type": "InteractionCounterStatistic",
                interactionType: "https://schema.org/WatchAction",
                userInteractionCount: video.viewsCount,
              },
            ],
            creator: {
              "@type": "Person",
              name: video.creator.displayName || "Creator",
            },
          }),
        }}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          <div className="flex-1 min-w-0 w-full max-w-5xl">
        {/* Back Button */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-white/60 hover:text-white text-sm mb-4 transition"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        {/* Video Player */}
        {notPlayable ? (
          <div className="aspect-video bg-surface-400/40 rounded-2xl flex flex-col items-center justify-center gap-3 px-6 text-center">
            {processingFailed ? (
              <>
                <XCircle className="w-12 h-12 text-red-400/70" />
                <p className="text-base font-medium text-white/90">
                  This video could not be processed
                </p>
                <p className="text-sm text-white/45 max-w-md">
                  {isOwner
                    ? "Bunny Stream could not encode the file, so it cannot play. Re-upload the file to try again."
                    : "It cannot be played yet. Please try another scene — the creator has been told."}
                </p>
              </>
            ) : (
              <>
                <Loader2 className="w-12 h-12 text-amber-400/80 animate-spin" />
                <p className="text-base font-medium text-white/90">
                  This video is still processing
                </p>
                <p className="text-sm text-white/45 max-w-md">
                  {isOwner
                    ? "Bunny Stream is preparing the playback qualities. It plays as soon as processing finishes — nothing else is needed from you."
                    : "It is not playable just yet. Refresh in a few minutes."}
                </p>
                {typeof encoding?.progress === "number" && (
                  <div className="w-56 bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-amber-400 h-full transition-all duration-500"
                      style={{ width: `${Math.max(3, encoding.progress)}%` }}
                    />
                  </div>
                )}
                {encoding && (
                  <p className="text-xs text-white/35">
                    {encoding.label} · {encoding.progress}%
                  </p>
                )}
              </>
            )}
          </div>
        ) : videoSrc ? (
          <VideoPlayer
            src={videoSrc}
            poster={video.thumbnailUrl || undefined}
            title={video.title}
            videoId={video.id}
            viewerId={user?.id}
            viewerPhone={user?.phone}
            viewerName={user?.displayName || undefined}
            isTeaser={!canPlayFull}
            startAt={canPlayFull ? startAt : 0}
            onDownload={canPlayFull ? () => handleDownload() : undefined}
            downloading={downloading}
          />
        ) : (
          // No playable source. For a paid scene without a teaser clip that is
          // deliberate: we would rather show nothing than sign a non-buyer into
          // the whole video, so say so instead of looking broken.
          <div className="aspect-video bg-surface-400/40 rounded-2xl flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Play className="w-16 h-16 text-white/10" />
            {!canPlayFull && video.price > 0 && (
              <p className="text-sm text-white/45 max-w-sm">
                {video.thumbnailUrl
                  ? "No preview clip for this scene."
                  : "No preview available."}{" "}
                Buy it to watch in full.
              </p>
            )}
          </div>
        )}

        {/* Scene photo gallery */}
        {(video.galleryImages?.length ?? 0) > 0 && (
          <section className="mt-4">
            <h2 className="font-display font-bold text-sm flex items-center gap-2 mb-2 text-white/80">
              <Images className="w-4 h-4 text-brand-400" /> Gallery
              <span className="text-white/40 font-normal">({video.galleryImages!.length})</span>
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {video.galleryImages!.map((img, i) => (
                <button
                  key={img.id}
                  onClick={() => setLightboxIndex(i)}
                  className="relative shrink-0 w-36 sm:w-44 aspect-video rounded-xl overflow-hidden group/gallery border border-white/5 hover:border-brand-500/60 transition"
                  aria-label={`Open photo ${i + 1}`}
                >
                  <Image
                    src={img.url}
                    alt={`${video.title} — photo ${i + 1}`}
                    fill
                    className="object-cover group-hover/gallery:scale-105 transition-transform duration-300"
                    sizes="176px"
                  />
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Video Info */}
        <div className="mt-6 space-y-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-display font-bold">{video.title}</h1>

            <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-white/50">
              <span className="flex items-center gap-1">
                <Eye className="w-4 h-4" />
                {formatCount(video.viewsCount)} views
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />
                {formatRelativeTime(new Date(video.createdAt))}
              </span>
              {video.category && (
                <span className="bg-surface-400/60 px-2.5 py-0.5 rounded-full text-xs">
                  {video.category}
                </span>
              )}
            </div>
          </div>

          {/* Creator Info + Purchase CTA */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-medium">
                {video.creator.displayName?.[0] || "C"}
              </div>
              <div>
                <p className="font-medium">{video.creator.displayName || "Creator"}</p>
                <p className="text-xs text-white/50">Creator</p>
              </div>
            </div>

            {notPlayable && !canPlayFull ? (
              /* Never sell something that cannot play. A buyer who pays here
                 gets a video that fails when they open it, which is the worst
                 possible first impression — and the creator is not at fault, so
                 blaming them helps nobody. */
              <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-sm font-medium text-white/80">
                  {processingFailed ? "Not available for purchase" : "Available soon"}
                </p>
                <p className="text-xs text-white/50 mt-1">
                  {processingFailed
                    ? "This video could not be processed, so it cannot be played or sold yet."
                    : "This video is still being processed. It becomes available to buy the moment it is ready."}
                </p>
              </div>
            ) : !canPlayFull && user && video.paymentUnderInvestigation ? (
              /* A charge for this video was approved but never settled. Selling
                 it again could take the customer's money twice, so the button
                 becomes a status panel that points at support instead. */
              <div className="max-w-md rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                  <Hourglass className="w-4 h-4 shrink-0" /> Payment being checked
                </p>
                <p className="text-xs text-white/60 mt-1">
                  You approved a {format(video.paymentUnderInvestigation.amount)} charge for
                  this video on your phone, but the money has not reached us yet. We are
                  checking with your network. <strong>Please do not pay again.</strong> If the
                  payment went through we will unlock this video automatically.
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <Link
                    href="/payments"
                    className="text-xs text-brand-400 hover:underline inline-flex items-center gap-1"
                  >
                    <ReceiptText className="w-3.5 h-3.5" /> Track this payment
                  </Link>
                  <span className="text-[11px] text-white/40">
                    Ref {video.paymentUnderInvestigation.providerRef ||
                      video.paymentUnderInvestigation.transactionId}
                  </span>
                </div>
              </div>
            ) : !canPlayFull && user ? (
              <button
                onClick={() => setShowPurchaseModal(true)}
                className="btn-brand flex items-center gap-2"
              >
                <Shield className="w-4 h-4" />
                Buy — {format(video.price)}
              </button>
            ) : !user ? (
              <Link href="/login" className="btn-brand text-center">
                Sign in to Buy
              </Link>
            ) : video.accessSource === "purchase" ? (
              <span className="badge-success text-sm px-4 py-2">
                ✓ Purchased
              </span>
            ) : (
              <span className="badge-success text-sm px-4 py-2">
                ✓ Full access
              </span>
            )}
          </div>

          {/* Description */}
          {video.description && (
            <div className="glass-card p-4">
              <h3 className="font-medium text-sm text-white/70 mb-2">Description</h3>
              <p className="text-sm text-white/60 whitespace-pre-wrap">{video.description}</p>
            </div>
          )}

          {/* Tags */}
          {video.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {video.tags.map((tag) => (
                <span key={tag} className="bg-surface-400/60 px-3 py-1 rounded-full text-xs text-white/50">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 border-t border-white/10 pt-4 flex-wrap">
            {/* Like / Dislike rating */}
            <div className="flex items-center gap-1 bg-surface-400/60 rounded-full px-2 py-1.5">
              <button
                onClick={() => handleRate("like")}
                className={`p-1 rounded-full transition ${liked ? "text-emerald-400 bg-emerald-500/20" : "text-white/60 hover:text-emerald-400"}`}
                title="Like"
              >
                <ThumbsUp className={`w-4 h-4 ${liked ? "fill-current" : ""}`} />
              </button>
              <span className="text-xs font-bold px-1.5">{ratingLabel}</span>
              <div className="w-16 h-1.5 bg-black/40 rounded-full overflow-hidden mx-1">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${ratingPct}%` }}
                />
              </div>
              <button
                onClick={() => handleRate("dislike")}
                className={`p-1 rounded-full transition ${disliked ? "text-red-400 bg-red-500/20" : "text-white/60 hover:text-red-400"}`}
                title="Dislike"
              >
                <ThumbsDown className={`w-4 h-4 ${disliked ? "fill-current" : ""}`} />
              </button>
            </div>

            {/* Tip */}
            <button
              onClick={() => setShowTipModal(true)}
              className="btn-ghost flex items-center gap-2 text-sm text-amber-400 hover:text-amber-300"
            >
              <Gift className="w-4 h-4" /> Tip Creator
            </button>

            {/* Watch Later */}
            <button
              onClick={toggleWatchLater}
              disabled={watchLaterBusy}
              className={`btn-ghost flex items-center gap-2 text-sm ${inWatchLater ? "text-brand-400" : ""}`}
            >
              {inWatchLater ? (
                <BookmarkCheck className="w-4 h-4" />
              ) : (
                <Bookmark className="w-4 h-4" />
              )}
              {inWatchLater ? "In Watch Later" : "Watch Later"}
            </button>

            {/* Add to playlist */}
            <button
              onClick={() => {
                if (!user) {
                  router.push("/login");
                  return;
                }
                setShowPlaylistModal(true);
              }}
              className="btn-ghost flex items-center gap-2 text-sm"
            >
              <ListPlus className="w-4 h-4" /> Add to playlist
            </button>

            {/* Members download — pick the rendition (mirrors the player button).
                Hidden while the video is not playable: the renditions do not
                exist yet, so the button would only produce a failed request. */}
            {canPlayFull && !notPlayable && video.accessSource !== null && (
              <div className="relative">
                <button
                  onClick={() => setShowDownloadMenu((v) => !v)}
                  disabled={downloading}
                  className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {downloading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Download
                  <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                </button>

                {showDownloadMenu && !downloading && (
                  <div className="absolute bottom-full mb-2 left-0 z-30 w-40 glass-card p-1.5 animate-slide-up">
                    <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/40">
                      Quality
                    </p>
                    {["1080p", "720p", "480p"].map((q) => (
                      <button
                        key={q}
                        onClick={() => {
                          setShowDownloadMenu(false);
                          handleDownload(q);
                        }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-sm text-white/80 hover:bg-white/10 transition"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Link href="/inbox" className="btn-ghost flex items-center gap-2 text-sm">
              <MessageCircle className="w-4 h-4" /> Messages
            </Link>
            <button onClick={handleShare} className="btn-ghost flex items-center gap-2 text-sm">
              <Share2 className="w-4 h-4" /> Share
            </button>
            <button
              onClick={() => setShowReportModal(true)}
              className="btn-ghost flex items-center gap-2 text-sm text-red-400 hover:text-red-300 ml-auto"
            >
              <Flag className="w-4 h-4" /> Report
            </button>
          </div>

          {/* Gallery lightbox */}
          {lightboxIndex !== null && (video.galleryImages?.length ?? 0) > 0 && (
            <div
              className="fixed inset-0 z-[110] bg-black/95 backdrop-blur flex items-center justify-center p-4"
              onClick={() => setLightboxIndex(null)}
            >
              <button
                onClick={() => setLightboxIndex(null)}
                className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 transition"
                aria-label="Close gallery"
              >
                <X className="w-5 h-5" />
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const total = video.galleryImages!.length;
                  setLightboxIndex((i) => (i === null ? 0 : (i - 1 + total) % total));
                }}
                className="absolute left-2 sm:left-4 p-3 rounded-full bg-white/10 hover:bg-white/20 transition"
                aria-label="Previous photo"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>

              <div
                className="relative w-full max-w-4xl aspect-[4/3] sm:aspect-video"
                onClick={(e) => e.stopPropagation()}
              >
                <Image
                  src={video.galleryImages![lightboxIndex].url}
                  alt={`${video.title} — photo ${lightboxIndex + 1}`}
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 896px"
                />
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const total = video.galleryImages!.length;
                  setLightboxIndex((i) => (i === null ? 0 : (i + 1) % total));
                }}
                className="absolute right-2 sm:right-4 p-3 rounded-full bg-white/10 hover:bg-white/20 transition"
                aria-label="Next photo"
              >
                <ChevronRight className="w-6 h-6" />
              </button>

              <span className="absolute bottom-5 text-xs text-white/60 font-mono">
                {lightboxIndex + 1} / {video.galleryImages!.length}
              </span>
            </div>
          )}

          {/* Add-to-playlist modal */}
          {showPlaylistModal && (
            <div
              className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setShowPlaylistModal(false)}
            >
              <div
                className="w-full max-w-md glass-card p-5 space-y-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-bold flex items-center gap-2">
                    <ListPlus className="w-5 h-5 text-brand-400" /> Add to playlist
                  </h3>
                  <button
                    onClick={() => setShowPlaylistModal(false)}
                    className="p-1.5 rounded-lg hover:bg-white/10 transition"
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {playlists.length === 0 ? (
                  <p className="text-sm text-white/50">
                    No playlists yet — create your first one below.
                  </p>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {playlists.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addToPlaylist(p.id)}
                        disabled={playlistBusy}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-white/10 text-sm transition disabled:opacity-50"
                      >
                        <span>{p.name}</span>
                        <span className="text-xs text-white/40">
                          {p.itemCount} video{p.itemCount === 1 ? "" : "s"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 pt-3 border-t border-white/10">
                  <input
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    placeholder="New playlist name"
                    className="flex-1 bg-surface-400/60 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-brand-500"
                  />
                  <button
                    onClick={createPlaylist}
                    disabled={playlistBusy}
                    className="btn-brand px-3"
                    aria-label="Create playlist"
                  >
                    {playlistBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Comments */}
          <CommentsSection
            videoId={video.id}
            user={user ? { id: user.id, role: user.role } : null}
          />
          </div>

          {/* Related Videos sidebar */}
          <aside className="w-full lg:w-80 shrink-0">
            <h2 className="font-display font-bold text-lg mb-4 flex items-center gap-2">
              <Play className="w-4 h-4 text-brand-400" /> Related Videos
            </h2>
            <div className="space-y-4">
              {related.length === 0 ? (
                <p className="text-sm text-white/40">No related videos yet.</p>
              ) : (
                related.map((r) => (
                  <Link key={r.id} href={`/video/${r.slug || r.id}`} className="flex gap-3 group">
                    <div className="relative w-28 aspect-video rounded-lg overflow-hidden shrink-0 bg-surface-300/60">
                      {r.thumbnailUrl ? (
                        <Image
                          src={r.thumbnailUrl}
                          alt={r.title}
                          fill
                          className="object-cover group-hover:scale-105 transition-transform duration-300"
                          sizes="112px"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Play className="w-5 h-5 text-white/30" />
                        </div>
                      )}
                      {r.price > 0 && (
                        <span className="absolute bottom-1 left-1 bg-black/70 text-[10px] px-1 rounded text-white">
                          {formatTZS(r.price)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium line-clamp-2 group-hover:text-brand-400 transition">
                        {r.title}
                      </p>
                      <p className="text-xs text-white/50 mt-1 truncate">
                        {r.creator.displayName || "Creator"}
                      </p>
                      <p className="text-xs text-white/30">{formatCount(r.viewsCount)} views</p>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </aside>
          </div>
        </div>
      </main>

      {/* Tip Modal */}
      {showTipModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-2 flex items-center gap-2">
              <Gift className="w-5 h-5 text-amber-400" /> Send a Tip
            </h2>
            <p className="text-white/60 text-sm mb-6">
              Support {video.creator.displayName || "this creator"} — 100% of tips go directly to them.
            </p>

            <div className="grid grid-cols-4 gap-2 mb-4">
              {[500, 1000, 5000, 10000].map((amt) => (
                <button
                  key={amt}
                  onClick={() => setTipAmount(amt.toString())}
                  className={`py-2 rounded-xl text-xs font-bold border transition ${
                    tipAmount === amt.toString()
                      ? "border-amber-500 bg-amber-500/10 text-amber-400"
                      : "border-white/10 text-white/60 hover:border-white/30"
                  }`}
                >
                  {amt.toLocaleString()}
                </button>
              ))}
            </div>

            <input
              type="number"
              value={tipAmount}
              onChange={(e) => setTipAmount(e.target.value)}
              min={500}
              max={100000}
              placeholder="Custom amount (TZS)"
              className="input-field mb-3"
            />
            <input
              type="text"
              value={tipMessage}
              onChange={(e) => setTipMessage(e.target.value)}
              placeholder="Add a message (optional)"
              maxLength={500}
              className="input-field mb-4"
            />

            <div className="flex gap-3">
              <button onClick={() => setShowTipModal(false)} className="btn-ghost flex-1">
                Cancel
              </button>
              <button
                onClick={handleTip}
                disabled={tipping || !tipAmount}
                className="btn-brand flex-1 disabled:opacity-50"
              >
                {tipping ? "Sending..." : `Tip ${formatTZS(parseInt(tipAmount) || 0)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report modal */}
      {showReportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setShowReportModal(false)}
        >
          <div
            className="glass-card w-full max-w-md p-6 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-display font-bold mb-2">Report this video</h2>
            <p className="text-white/60 text-sm mb-4">
              Tell us what is wrong. Our moderators review every report.
            </p>

            <span className="text-sm text-white/60 mb-2 block">Reason</span>
            <div className="flex flex-wrap gap-2 mb-4">
              {REPORT_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  onClick={() => setReportReason(reason)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                    reportReason === reason
                      ? "border-brand-500 bg-brand-500/10 text-brand-400"
                      : "border-white/10 text-white/60 hover:border-white/30"
                  }`}
                >
                  {REPORT_LABELS[reason]}
                </button>
              ))}
            </div>

            {reportReason === "OTHER" && (
              <>
                <label className="text-sm text-white/60 mb-2 block" htmlFor="report-description">
                  Describe the problem
                </label>
                <textarea
                  id="report-description"
                  value={reportDescription}
                  onChange={(e) => setReportDescription(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="What is wrong with this video?"
                  className="input-field"
                />
              </>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowReportModal(false)}
                className="btn-ghost flex-1"
              >
                Cancel
              </button>
              <button
                onClick={handleReport}
                disabled={
                  reporting ||
                  (reportReason === "OTHER" && !reportDescription.trim())
                }
                className="btn-brand flex-1 disabled:opacity-50"
              >
                {reporting ? "Submitting..." : "Submit report"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purchase Modal */}
      {showPurchaseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-2">Buy Video</h2>
            <p className="text-white/60 text-sm mb-6">
              Choose your payment method and enter your details.
            </p>

            <div className="space-y-4">
              {/* Payment method — HarakaPay USSD push (all networks supported) */}
              <div>
                <label className="text-sm text-white/60 mb-2 block">Payment Method</label>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-brand-500/30 bg-brand-500/10">
                  <Smartphone className="w-5 h-5 text-brand-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-400">HarakaPay</p>
                    <p className="text-xs text-white/50">
                      USSD push — works with Vodacom, Tigo &amp; Airtel. Confirm with your PIN.
                    </p>
                  </div>
                </div>
              </div>

              {/* Phone Number */}
              <div>
                <label className="text-sm text-white/60 mb-2 block">Phone Number</label>
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="07XX XXX XXX"
                  className="input-field"
                />
              </div>

              {/* Price Summary + coupon */}
              <div className="bg-surface-300/40 rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-white/60">Video price</span>
                  <span className="font-bold">{formatTZS(video.price)}</span>
                </div>
                {couponDiscount > 0 && (
                  <>
                    <div className="flex justify-between text-sm text-emerald-400">
                      <span>Coupon discount</span>
                      <span>−{formatTZS(couponDiscount)}</span>
                    </div>
                    <div className="flex justify-between text-sm border-t border-white/10 pt-2">
                      <span className="text-white/60">You pay</span>
                      <span className="font-bold text-brand-400">
                        {formatTZS(Math.max(0, video.price - couponDiscount))}
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Promo code */}
              <div>
                <label className="text-sm text-white/60 mb-2 block flex items-center gap-1.5">
                  <Ticket className="w-4 h-4" /> Promo code (optional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="e.g. WELCOME10"
                    className="input-field uppercase flex-1"
                    maxLength={32}
                  />
                  <button
                    type="button"
                    onClick={previewPurchaseCoupon}
                    className="btn-ghost px-4 text-sm shrink-0"
                  >
                    Apply
                  </button>
                </div>
                {couponError && (
                  <p className="text-xs text-red-400 mt-1">{couponError}</p>
                )}
                {couponDiscount > 0 && (
                  <p className="text-xs text-emerald-400 mt-1">
                    ✓ You save {formatTZS(couponDiscount)}
                  </p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={() => setShowPurchaseModal(false)}
                  className="btn-ghost flex-1"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePurchase}
                  disabled={purchasing || !phoneNumber}
                  className="btn-brand flex-1"
                >
                  {purchasing ? "Processing..." : "Pay Now"}
                </button>
              </div>

              {/* Wallet balance — instant, no USSD push. Only offered when the
                  balance actually covers the price. */}
              {(user?.walletBalance || 0) >=
                Math.max(0, (video.price || 0) - couponDiscount) && (
                <div className="border-t border-white/10 pt-4">
                  <button
                    onClick={handleWalletPurchase}
                    disabled={purchasing}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-4 py-3 text-sm font-medium transition hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Wallet className="w-4 h-4" />
                    Pay {formatTZS(Math.max(0, (video.price || 0) - couponDiscount))} from
                    wallet
                  </button>
                  <p className="text-xs text-white/40 mt-2 text-center">
                    Balance {formatTZS(user?.walletBalance || 0)} · no phone prompt needed
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
