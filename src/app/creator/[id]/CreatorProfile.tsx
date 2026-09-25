"use client";

// =============================================================================
// GENHUB - Creator public profile (client half)
// Fetches the creator, their videos and subscription state, then renders the
// profile. The SEO shell (generateMetadata + JSON-LD) lives in ./page.tsx.
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import Header from "@/components/Header";
import VideoCard from "@/components/VideoCard";
import { Play, Users, Eye, Heart, Star, ArrowLeft, Smartphone, Wallet, MessageCircle } from "lucide-react";
import { formatTZS, formatCount } from "@/lib/utils";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";

interface CreatorProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  creatorProfile: {
    bio: string | null;
    coverImageUrl: string | null;
    subscriptionPrice: number | null;
    totalSubscribers: number;
    socialLinks: any;
  } | null;
  _count: { videos: number };
}

interface Video {
  id: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  viewsCount: number;
  likesCount: number;
  createdAt: string;
}

export default function CreatorProfileClient({ params }: { params: { id: string } }) {
  const { id } = params;
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  // When the paid month ends. A subscription is a month of access, so the date
  // is the thing the viewer actually bought — "Subscribed" alone does not say
  // whether it runs out tomorrow or next month.
  const [subExpiresAt, setSubExpiresAt] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [showSubModal, setShowSubModal] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [walletPaying, setWalletPaying] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  const fetchCreator = useCallback(async () => {
    try {
      const [creatorRes, videosRes, subRes] = await Promise.all([
        fetch(`/api/creators/${id}`),
        fetch(`/api/videos?creatorId=${id}`),
        fetch(`/api/subscriptions?creatorId=${id}`),
      ]);

      const creatorData = await creatorRes.json();
      const videosData = await videosRes.json();
      const subData = await subRes.json();

      if (creatorData.success) setCreator(creatorData.data);
      if (videosData.success) setVideos(videosData.data.videos || []);
      if (subData.success) {
        setSubscribed(subData.data.subscribed);
        setSubExpiresAt(subData.data.subscription?.expiresAt ?? null);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCreator();
  }, [fetchCreator]);

  // Open the checkout modal — subscribing pays by phone like every other
  // purchase on the site (HarakaPay USSD push), with wallet as a fallback.
  function openSubscribe() {
    setShowSubModal(true);
  }

  async function refreshSubState() {
    try {
      const res = await fetch(`/api/subscriptions?creatorId=${id}`);
      const data = await res.json();
      if (data.success) {
        setSubscribed(data.data.subscribed);
        setSubExpiresAt(data.data.subscription?.expiresAt ?? null);
      }
    } catch {}
  }

  // Pay for the subscription by phone (HarakaPay USSD push)
  async function handlePayWithPhone() {
    if (!phoneNumber) return;
    setSubscribing(true);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId: id, phoneNumber }),
      });
      const data = await res.json();
      if (res.status === 401) {
        setShowSubModal(false);
        toast("warning", "Sign in to subscribe.");
        router.push("/login");
        return;
      }
      if (data.success && data.data?.sandbox) {
        // Local dev: no real USSD push — complete through the same webhook
        // processor production uses, then flip the UI to subscribed.
        const done = await fetch("/api/dev/sandbox/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: data.data.orderId }),
        });
        const doneData = await done.json();
        if (doneData.success) {
          setShowSubModal(false);
          setSubscribed(true);
          toast("success", "Subscription active — welcome! 🎉");
        } else {
          toast("error", doneData.error || "Sandbox payment failed");
        }
      } else if (data.success) {
        // Live HarakaPay: USSD push sent — poll until the gateway confirms
        setShowSubModal(false);
        toast("info", "USSD push sent to your phone — enter your PIN to confirm.");
        pollSubscription(data.data.transactionId);
      } else {
        toast("error", data.error || "Payment failed");
      }
    } catch {
      toast("error", "An error occurred. Please try again.");
    } finally {
      setSubscribing(false);
    }
  }

  // Pay from the Genhub wallet balance (instant, no gateway)
  async function handlePayWithWallet() {
    setWalletPaying(true);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId: id }),
      });
      const data = await res.json();
      if (res.status === 401) {
        setShowSubModal(false);
        toast("warning", "Sign in to subscribe.");
        router.push("/login");
        return;
      }
      if (data.success) {
        setShowSubModal(false);
        setSubscribed(true);
        toast("success", "Subscription active — welcome! 🎉");
      } else {
        toast("error", data.error || "Could not subscribe");
      }
    } catch {
      toast("error", "An error occurred. Please try again.");
    } finally {
      setWalletPaying(false);
    }
  }

  // Poll the transaction until HarakaPay completes/fails it (webhook or reconcile)
  // ~2 minutes: entering a USSD PIN can easily take a minute on a slow network.
  function pollSubscription(transactionId: string, attempt = 0) {
    if (attempt >= 40) {
      toast("warning", "Payment is still processing — refresh the page in a minute.");
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/status/${transactionId}`);
        const data = await res.json();
        if (!data.success) return pollSubscription(transactionId, attempt + 1);
        const status = data.data.status;
        if (status === "SUCCESS") {
          setSubscribed(true);
          toast("success", "Subscription active — welcome! 🎉");
          refreshSubState();
          return;
        }
        if (status === "FAILED") {
          toast("error", "Payment failed or was cancelled. Please try again.");
          return;
        }
        pollSubscription(transactionId, attempt + 1);
      } catch {
        pollSubscription(transactionId, attempt + 1);
      }
    }, 3000);
  }

  async function handleUnsubscribe() {
    setSubscribing(true);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId: id }),
      });
      const data = await res.json();
      if (data.success) {
        setSubscribed(false);
        toast("info", "You have unsubscribed.");
      } else {
        toast("error", data.error || "Could not unsubscribe");
      }
    } catch {
      toast("error", "An error occurred");
    } finally {
      setSubscribing(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="skeleton h-48 w-full" />
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="skeleton h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!creator) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <p className="text-white/50">Creator not found</p>
        </div>
      </div>
    );
  }

  const subPrice = creator.creatorProfile?.subscriptionPrice || 5000;

  return (
    <div className="min-h-screen">
      <Header />

      {/* Cover / Banner */}
      <div className="relative h-48 md:h-64 bg-gradient-to-br from-brand-500/20 via-surface-300 to-surface-500 overflow-hidden">
        {creator.creatorProfile?.coverImageUrl && (
          // Creator-supplied URL on an arbitrary host, so next/image cannot
          // optimise it (an unconfigured remotePattern throws).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={creator.creatorProfile.coverImageUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        )}
        <Link
          href="/"
          className="absolute top-4 left-4 p-2 rounded-xl bg-black/40 hover:bg-black/60 transition"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
      </div>

      {/* Profile Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 -mt-16 relative z-10">
        <div className="flex flex-col sm:flex-row items-start gap-4 mb-8">
          {/* Avatar */}
          <div className="w-24 h-24 rounded-full bg-surface-300 border-4 border-surface-500 flex items-center justify-center text-3xl font-bold text-brand-400 overflow-hidden">
            {creator.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={creator.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              creator.displayName?.[0] || "C"
            )}
          </div>

          <div className="flex-1 mt-2">
            <h1 className="text-2xl font-display font-bold">{creator.displayName || "Creator"}</h1>
            {creator.creatorProfile?.bio && (
              <p className="text-sm text-white/60 mt-1 max-w-xl">{creator.creatorProfile.bio}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-sm text-white/50">
              <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {formatCount(creator.creatorProfile?.totalSubscribers || 0)} subscribers</span>
              <span className="flex items-center gap-1"><Play className="w-4 h-4" /> {creator._count.videos} videos</span>
            </div>
          </div>

          {/* Subscribe + message */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-4 sm:mt-0">
            {!subscribed ? (
              <button
                onClick={openSubscribe}
                disabled={subscribing}
                className="btn-brand flex items-center justify-center gap-2"
              >
                <Star className="w-4 h-4" />
                {subscribing ? "Subscribing..." : `Subscribe — TZS ${subPrice.toLocaleString()}/month`}
              </button>
            ) : (
              <button
                onClick={handleUnsubscribe}
                disabled={subscribing}
                title="Click to unsubscribe"
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-sm text-emerald-300 hover:border-emerald-500/70 transition"
              >
                <Star className="w-4 h-4 text-amber-400" />
                {subscribing
                  ? "Updating..."
                  : subExpiresAt
                    ? `Subscribed until ${new Date(subExpiresAt).toLocaleDateString()}`
                    : "✓ Subscribed — click to unsubscribe"}
              </button>
            )}

            {/* Messages are paid per message, and the composer in /inbox is where
                the price is set — so this is the way in. */}
            <Link
              href={`/inbox?userId=${creator.id}`}
              className="btn-ghost flex items-center justify-center gap-2 text-sm"
            >
              <MessageCircle className="w-4 h-4" /> Message
            </Link>
          </div>
        </div>

        {/* Videos Grid */}
        <h2 className="font-display font-bold text-lg mb-1">Videos by {creator.displayName}</h2>
        {/* What the viewer's money buys here, in one line. */}
        {subscribed ? (
          <p className="text-xs text-emerald-400 mb-4">
            Your subscription includes every video below
            {subExpiresAt ? ` until ${new Date(subExpiresAt).toLocaleDateString()}` : ""} —
            nothing else to pay.
          </p>
        ) : (
          <p className="text-xs text-white/40 mb-4">
            {videos.some((v) => v.price > 0)
              ? `Subscribe for TZS ${subPrice.toLocaleString()}/month and watch everything below, or buy a single video and keep it.`
              : "These videos are free to watch."}
          </p>
        )}
        {videos.length === 0 ? (
          <div className="text-center py-16">
            <Play className="w-12 h-12 text-white/10 mx-auto mb-3" />
            <p className="text-white/40">No videos yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
            {videos.map((v) => (
              <VideoCard
                key={v.id}
                {...v}
                creator={{ id: creator.id, displayName: creator.displayName, avatarUrl: creator.avatarUrl }}
                teaserDuration={15}
              />
            ))}
          </div>
        )}
      </div>

      {/* Subscribe checkout modal — phone (USSD push) primary, wallet fallback */}
      {showSubModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-2">Subscribe</h2>
            <p className="text-white/60 text-sm mb-6">
              {creator.displayName || "This creator"} — TZS {subPrice.toLocaleString()}/month.
              Cancel anytime.
            </p>

            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-brand-500/30 bg-brand-500/10 mb-3">
                  <Smartphone className="w-5 h-5 text-brand-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-400">HarakaPay</p>
                    <p className="text-xs text-white/50">
                      USSD push — works with Vodacom, Tigo &amp; Airtel. Confirm with your PIN.
                    </p>
                  </div>
                </div>
                <label className="text-sm text-white/60 mb-2 block">Phone Number</label>
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="07XX XXX XXX"
                  className="input-field"
                />
              </div>

              <div className="bg-surface-300/40 rounded-xl p-4 flex justify-between text-sm">
                <span className="text-white/60">Total per month</span>
                <span className="font-bold text-brand-400">TZS {subPrice.toLocaleString()}</span>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowSubModal(false)}
                  className="btn-ghost px-4"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePayWithWallet}
                  disabled={subscribing || walletPaying}
                  className="btn-ghost flex items-center gap-1.5 disabled:opacity-50"
                  title="Pay from your Genhub wallet balance"
                >
                  <Wallet className="w-4 h-4" />
                  {walletPaying ? "…" : "Balance"}
                </button>
                <button
                  onClick={handlePayWithPhone}
                  disabled={subscribing || !phoneNumber}
                  className="btn-brand flex-1 disabled:opacity-50"
                >
                  {subscribing ? "Processing..." : "Pay Now"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
