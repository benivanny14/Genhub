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
import VerifiedBadge from "@/components/VerifiedBadge";
import { formatTZS, formatCount } from "@/lib/utils";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { canOptimizeImage } from "@/lib/media";
import { SUBSCRIPTION_PRICE_TZS } from "@/lib/subscription";
import { PAID_MESSAGE_PRICE } from "@/lib/pay-message";
import { displayHandle } from "@/lib/usernames";

interface CreatorProfile {
  id: string;
  /** The unique public handle; shown as @username, with displayName as fallback. */
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * The blue tick. Already resolved by the API (a bought badge has an expiry,
   * so the flag alone is not the answer) — this component only draws it.
   */
  isVerified?: boolean;
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

  // The creator's own price when they have one; the platform price otherwise.
  // Never a bare literal: this page, the subscribe API and the creators list all
  // quote the same number, and a hand-written copy is how they drift apart.
  const subPrice = creator.creatorProfile?.subscriptionPrice || SUBSCRIPTION_PRICE_TZS;

  return (
    <div className="min-h-screen">
      <Header />

      {/* Cover / Banner */}
      <div className="relative h-48 md:h-64 bg-gradient-to-br from-brand-500/20 via-surface-300 to-surface-500 overflow-hidden">
        {creator.creatorProfile?.coverImageUrl && (
          // The cover is creator-supplied and may live on any host, so it is
          // optimised only when it is a public file we host (canOptimizeImage).
          // `fill` because the banner's height is set by the container, not by
          // the picture — the old <img> stretched whatever aspect it was given.
          <Image
            src={creator.creatorProfile.coverImageUrl}
            alt=""
            fill
            priority
            sizes="100vw"
            unoptimized={!canOptimizeImage(creator.creatorProfile.coverImageUrl)}
            className="object-cover"
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
          <div className="relative">
            <div className="w-24 h-24 rounded-full bg-surface-300 border-4 border-surface-500 flex items-center justify-center text-3xl font-bold text-brand-400 overflow-hidden">
              {creator.avatarUrl ? (
                <Image
                  src={creator.avatarUrl}
                  alt=""
                  width={96}
                  height={96}
                  unoptimized={!canOptimizeImage(creator.avatarUrl)}
                  className="w-full h-full object-cover"
                />
              ) : (
                (creator.username?.[0] || creator.displayName?.[0] || "C").toUpperCase()
              )}
            </div>

            {/* The blue tick, on the avatar as well as the name. It has to be
                findable at a glance on a page full of faces, so it is drawn
                twice — the full-size badge on the picture is what makes a
                verified profile readable before anything is read. */}
            {creator.isVerified && (
              <span
                title="Verified creator"
                className="absolute -bottom-0.5 -right-0.5 w-8 h-8 rounded-full bg-surface-500 border-2 border-surface-500 flex items-center justify-center"
              >
                <VerifiedBadge className="h-7 w-7" />
              </span>
            )}
          </div>

          <div className="flex-1 mt-2">
            <h1 className="text-2xl font-display font-bold flex items-center gap-2 flex-wrap">
              {displayHandle(creator, "Creator")}
              {creator.isVerified && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-300">
                  <VerifiedBadge className="h-4 w-4" /> Verified
                </span>
              )}
            </h1>
            {/* The display name is kept as a secondary line, so a creator who
                is known by their real name does not lose it — the @handle is
                the identity, the name is what people call them. */}
            {creator.displayName && creator.username && (
              <p className="text-sm text-white/50 mt-1">{creator.displayName}</p>
            )}
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

            {/* Messages are paid per message at a fixed price (see
                lib/pay-message.ts), and a subscription is the DOOR to them:
                /api/messages refuses a viewer who does not follow the creator.
                So the link is offered only to somebody who is through that
                door — a Message button that opens a composer the send button
                then refuses is a dead end, and it advertised a free inbox that
                does not exist. The Subscribe button beside it is the way in. */}
            {subscribed ? (
              <Link
                href={`/inbox?userId=${creator.id}`}
                className="btn-ghost flex items-center justify-center gap-2 text-sm"
              >
                <MessageCircle className="w-4 h-4" /> Message
              </Link>
            ) : (
              <button
                type="button"
                disabled
                title={`Subscribe to ${displayHandle(creator, "this creator")} first — messages then cost TZS ${PAID_MESSAGE_PRICE} each`}
                className="btn-ghost flex items-center justify-center gap-2 text-sm opacity-40 cursor-not-allowed"
              >
                <MessageCircle className="w-4 h-4" /> Subscribe to message
              </button>
            )}
          </div>
        </div>

        {/* Videos Grid */}
        <h2 className="font-display font-bold text-lg mb-1">
          Videos by {displayHandle(creator, "this creator")}
        </h2>
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
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 pb-12">
            {videos.map((v) => (
              <VideoCard
                key={v.id}
                {...v}
                creator={{
                  id: creator.id,
                  username: creator.username,
                  displayName: creator.displayName,
                  avatarUrl: creator.avatarUrl,
                }}
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
              {displayHandle(creator, "This creator")} — TZS {subPrice.toLocaleString()}/month.
              Cancel anytime.
            </p>

            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-brand-500/30 bg-brand-500/10 mb-3">
                  <Smartphone className="w-5 h-5 text-brand-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-400">Mobile money</p>
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
