"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  Wallet,
  Eye,
  DollarSign,
  TrendingUp,
  Clock,
  Upload,
  AlertCircle,
  CheckCircle,
  ArrowUpRight,
  Film,
  BarChart3,
  Banknote,
  XCircle,
  Loader2,
} from "lucide-react";
import { formatTZS, formatRelativeTime, formatCount } from "@/lib/utils";

interface CreatorData {
  balance: {
    pendingBalance: number;
    availableBalance: number;
    totalEarned: number;
  };
  todayEarnings: number;
  totalViews: number;
  videoStats: {
    id: string;
    title: string;
    viewsCount: number;
    purchaseCount: number;
    price: number;
    totalEarned: number;
    createdAt: string;
  }[];
  recentTransactions: {
    id: string;
    amount: number;
    creatorCut: number | null;
    type: string;
    createdAt: string;
    video?: { title: string } | null;
  }[];
}

interface UserData {
  id: string;
  kycStatus: string;
  role: string;
}

/** Bunny's processing state for one of the creator's videos. */
interface EncodingState {
  state: "pending" | "processing" | "ready" | "failed" | "untracked";
  status: number | null;
  progress: number;
  label: string;
  error: string | null;
}

interface CreatorVideo {
  id: string;
  title: string;
  slug: string | null;
  price: number;
  isPublished: boolean;
  viewsCount: number;
  purchaseCount: number;
  createdAt: string;
  encoding: EncodingState;
}

/**
 * Live processing badge. "Not tracked" renders as a dash rather than a badge: a
 * side-loaded video has no encoding lifecycle, and showing it a fake "Ready"
 * would devalue the real ones.
 */
function EncodingBadge({ encoding }: { encoding?: EncodingState }) {
  if (!encoding || encoding.state === "untracked") {
    return <span className="text-xs text-white/25">—</span>;
  }

  if (encoding.state === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-red-400"
        title={encoding.error || "Bunny Stream could not process this file"}
      >
        <XCircle className="w-3.5 h-3.5" /> Failed
      </span>
    );
  }

  if (encoding.state === "ready") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
        <CheckCircle className="w-3.5 h-3.5" /> Ready
      </span>
    );
  }

  return (
    <div className="min-w-[110px]">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {encoding.label} {encoding.progress}%
      </span>
      <div className="mt-1 bg-white/10 rounded-full h-1 overflow-hidden">
        <div
          className="bg-amber-400 h-full transition-all duration-500"
          style={{ width: `${Math.max(4, encoding.progress)}%` }}
        />
      </div>
    </div>
  );
}

export default function CreatorDashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const [creatorData, setCreatorData] = useState<CreatorData | null>(null);
  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState(0);
  const [payoutMethod, setPayoutMethod] = useState("MPESA");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [requestingPayout, setRequestingPayout] = useState(false);
  const [videos, setVideos] = useState<CreatorVideo[]>([]);
  const [processingCount, setProcessingCount] = useState(0);
  const [awaitingPublish, setAwaitingPublish] = useState(0);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [balanceRes, userRes, videosRes] = await Promise.all([
        fetch("/api/creator/balance"),
        fetchCurrentUser(),
        fetch("/api/creator/videos"),
      ]);

      const balanceData = await balanceRes.json();
      const userData = await userRes.json();
      const videosData = await videosRes.json();

      if (balanceData.success) setCreatorData(balanceData.data);
      if (userData.success) setUser(userData.data);
      if (videosData.success) {
        setVideos(videosData.data.videos || []);
        setProcessingCount(videosData.data.processing || 0);
        setAwaitingPublish(videosData.data.awaitingPublish || 0);
      }

      if (!userData.success) router.push("/login");
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // While anything is still transcoding, re-read so the progress the creator is
  // watching actually moves. Stops on its own once everything is settled, so an
  // idle dashboard makes no requests at all.
  useEffect(() => {
    if (processingCount === 0) return;
    const timer = setInterval(fetchData, 8000);
    return () => clearInterval(timer);
  }, [processingCount, fetchData]);

  /**
   * Publish by hand. The automatic path holds a video back until Bunny can
   * serve it; this is the way out when Bunny never says it finished.
   */
  async function togglePublished(video: CreatorVideo) {
    const next = !video.isPublished;
    if (
      next &&
      video.encoding.state !== "ready" &&
      !confirm(
        `This video is still ${video.encoding.label.toLowerCase()}. ` +
          "Publishing now may show viewers a video that will not play. Publish anyway?"
      )
    ) {
      return;
    }

    setPublishingId(video.id);
    try {
      const res = await fetch(`/api/creator/videos/${video.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ published: next }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "Could not update the video");
        return;
      }
      if (data.data?.warning) toast("warning", data.data.warning);
      else toast("success", next ? "Video published" : "Video unpublished");
      await fetchData();
    } catch {
      toast("error", "Network error");
    } finally {
      setPublishingId(null);
    }
  }

  async function handlePayout() {
    if (!payoutAmount || !payoutAccount) return;
    setRequestingPayout(true);

    try {
      const res = await fetch("/api/creator/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payoutAmount,
          paymentMethod: payoutMethod,
          accountDetails: payoutAccount,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setShowPayoutModal(false);
        toast("success", "Payout request submitted!");
        fetchData();
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Network error");
    } finally {
      setRequestingPayout(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-32 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const balance = creatorData?.balance;
  const canRequestPayout =
    (balance?.availableBalance || 0) >= 30000 && user?.kycStatus === "APPROVED";

  // The performance table is driven by the balance endpoint (money) and the
  // encoding column by /api/creator/videos (processing) — joined here so neither
  // endpoint has to know about the other's job.
  const encodingById = new Map(videos.map((v) => [v.id, v]));

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-display font-bold">Creator Dashboard</h1>
            <p className="text-white/50 text-sm">Track your earnings and video performance</p>
          </div>
          <div className="flex gap-3">
            <Link href="/creator/analytics" className="btn-ghost flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Analytics
            </Link>
            {user?.kycStatus !== "APPROVED" && (
              <Link href="/creator/kyc" className="btn-ghost flex items-center gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4" /> Complete KYC
              </Link>
            )}
            <Link href="/creator/upload" className="btn-brand flex items-center gap-2">
              <Upload className="w-4 h-4" /> Upload Video
            </Link>
          </div>
        </div>

        {/* KYC Warning */}
        {user?.kycStatus !== "APPROVED" && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-400 text-sm">
                KYC not yet verified
              </p>
              <p className="text-xs text-amber-400/60 mt-1">
                You must complete KYC verification before uploading videos or requesting payouts.
                <Link href="/creator/kyc" className="underline ml-1">
                  Submit now
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Balance Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-brand-400" />
              </div>
              <span className="text-sm text-white/60">Total Earnings</span>
            </div>
            <p className="text-2xl font-bold">{formatTZS(balance?.totalEarned || 0)}</p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-emerald-400" />
              </div>
              <span className="text-sm text-white/60">Available Balance</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400">
              {formatTZS(balance?.availableBalance || 0)}
            </p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                <Clock className="w-5 h-5 text-amber-400" />
              </div>
              <span className="text-sm text-white/60">Pending (14 days)</span>
            </div>
            <p className="text-2xl font-bold text-amber-400">
              {formatTZS(balance?.pendingBalance || 0)}
            </p>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-brand-400" />
              </div>
              <span className="text-sm text-white/60">Today&apos;s Earnings</span>
            </div>
            <p className="text-2xl font-bold text-brand-400">
              {formatTZS(creatorData?.todayEarnings || 0)}
            </p>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="glass-card p-4 text-center">
            <Eye className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">{formatCount(creatorData?.totalViews || 0)}</p>
            <p className="text-xs text-white/40">Total Views</p>
          </div>
          <div className="glass-card p-4 text-center">
            <Film className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">{creatorData?.videoStats.length || 0}</p>
            <p className="text-xs text-white/40">Videos</p>
          </div>
          <div className="glass-card p-4 text-center">
            <BarChart3 className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">
              {creatorData?.videoStats.reduce((s, v) => s + v.purchaseCount, 0) || 0}
            </p>
            <p className="text-xs text-white/40">Purchases</p>
          </div>
          <div className="glass-card p-4 text-center">
            <Banknote className="w-5 h-5 text-white/40 mx-auto mb-1" />
            <p className="text-lg font-bold">70%</p>
            <p className="text-xs text-white/40">Your Revenue Share</p>
          </div>
        </div>

        {/* Request Payout Button */}
        <button
          onClick={() => {
            setPayoutAmount(balance?.availableBalance || 0);
            setShowPayoutModal(true);
          }}
          disabled={!canRequestPayout}
          className="btn-brand w-full sm:w-auto flex items-center justify-center gap-2"
        >
          <Banknote className="w-5 h-5" />
          Request Payout
          {!canRequestPayout && (
            <span className="text-xs opacity-60">
              (Min: TZS 30,000 + KYC required)
            </span>
          )}
        </button>

        {/* Videos still transcoding are held back from the public feed until
            they can actually play, so say so rather than letting a creator
            wonder why a finished upload is not live. */}
        {awaitingPublish > 0 && (
          <div className="glass-card p-4 flex items-start gap-3 border border-amber-500/20 bg-amber-500/5">
            <Loader2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
            <div className="text-sm">
              <p className="font-medium text-amber-300">
                {awaitingPublish === 1
                  ? "1 video is still processing"
                  : `${awaitingPublish} videos are still processing`}
              </p>
              <p className="text-white/50 mt-0.5">
                They will go live on their own the moment Bunny Stream finishes —
                no action needed. You will get a notification when each one is ready.
              </p>
            </div>
          </div>
        )}

        {/* Video Performance Table */}
        <div className="glass-card overflow-hidden">
          <div className="p-4 border-b border-white/10">
            <h2 className="font-display font-bold">Video Performance</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-white/50 border-b border-white/5">
                  <th className="px-4 py-3">Video</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Views</th>
                  <th className="px-4 py-3">Sales</th>
                  <th className="px-4 py-3">Revenue</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {(creatorData?.videoStats || []).map((v) => (
                  <tr key={v.id} className="border-b border-white/5 hover:bg-white/5 transition">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium truncate max-w-[200px]">{v.title}</p>
                      <p className="text-xs text-white/40">
                        {formatRelativeTime(new Date(v.createdAt))}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm">{formatTZS(v.price)}</td>
                    <td className="px-4 py-3 text-sm">{formatCount(v.viewsCount)}</td>
                    <td className="px-4 py-3 text-sm">{v.purchaseCount}</td>
                    <td className="px-4 py-3 text-sm font-medium text-emerald-400">
                      {formatTZS(v.totalEarned)}
                    </td>
                    <td className="px-4 py-3">
                      <EncodingBadge encoding={encodingById.get(v.id)?.encoding} />
                      {encodingById.get(v.id)?.isPublished === false && (
                        <button
                          onClick={() => {
                            const video = encodingById.get(v.id);
                            if (video) togglePublished(video);
                          }}
                          disabled={publishingId === v.id}
                          className="mt-1 flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50"
                        >
                          {publishingId === v.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Upload className="w-3 h-3" />
                          )}
                          Publish now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(!creatorData?.videoStats || creatorData.videoStats.length === 0) && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-white/40">
                      No videos yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Transactions */}
        <div className="glass-card p-4">
          <h2 className="font-display font-bold mb-4">Recent Transactions</h2>
          <div className="space-y-3">
            {(creatorData?.recentTransactions || []).map((tx) => (
              <div
                key={tx.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-surface-300/30"
              >
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <ArrowUpRight className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="flex-1">
                  <p className="text-sm">
                    {tx.type === "PPV_PURCHASE"
                      ? `Sold: ${tx.video?.title || "Video"}`
                      : tx.type}
                  </p>
                  <p className="text-xs text-white/40">
                    {formatRelativeTime(new Date(tx.createdAt))}
                  </p>
                </div>
                <p className="font-bold text-sm text-emerald-400">
                  +{formatTZS(tx.creatorCut || tx.amount)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Payout Modal */}
      {showPayoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-2">Request Payout</h2>
            <p className="text-sm text-white/50 mb-4">
              Available balance: {formatTZS(balance?.availableBalance || 0)}
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-white/60 mb-2 block">Amount (TZS)</label>
                <input
                  type="number"
                  value={payoutAmount}
                  onChange={(e) => setPayoutAmount(parseInt(e.target.value) || 0)}
                  min={30000}
                  max={balance?.availableBalance || 0}
                  className="input-field"
                />
              </div>

              <div>
                <label className="text-sm text-white/60 mb-2 block">Payment Method</label>
                <select
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(e.target.value)}
                  className="input-field"
                >
                  <option value="MPESA">M-Pesa</option>
                  <option value="TIGO_PESA">Tigo Pesa</option>
                  <option value="AIRTEL_MONEY">Airtel Money</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </select>
              </div>

              <div>
                <label className="text-sm text-white/60 mb-2 block">Account Details</label>
                <input
                  type="text"
                  value={payoutAccount}
                  onChange={(e) => setPayoutAccount(e.target.value)}
                  placeholder="Phone number or bank account"
                  className="input-field"
                />
              </div>

              <div className="flex gap-3">
                <button onClick={() => setShowPayoutModal(false)} className="btn-ghost flex-1">
                  Cancel
                </button>
                <button
                  onClick={handlePayout}
                  disabled={requestingPayout || payoutAmount < 30000 || !payoutAccount}
                  className="btn-brand flex-1"
                >
                  {requestingPayout ? "Submitting..." : "Submit Request"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
