"use client";

// =============================================================================
// GENHUB - Billing management page
// One place to manage memberships: active creator subscriptions with a cancel
// action, the wallet balance, and the full payment history.
// =============================================================================

import { useState, useEffect } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { useCurrency } from "@/lib/currency";
import Image from "next/image";
import { canOptimizeImage } from "@/lib/media";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  CreditCard,
  Wallet,
  Loader2,
  RefreshCcw,
  AlertTriangle,
  ArrowRight,
  ReceiptText,
  X,
} from "lucide-react";

interface Subscription {
  id: string;
  price: number;
  startDate: string;
  expiresAt: string;
  isActive: boolean;
  autoRenew: boolean;
  /** Automatic-renewal bookkeeping (see subscription-renewal.service.ts) */
  renewAttempts?: number;
  lastRenewError?: string | null;
  lastRenewedAt?: string | null;
  creator: { id: string; displayName: string | null; avatarUrl: string | null };
}

interface Transaction {
  id: string;
  amount: number;
  type: string;
  status: string;
  gateway: string | null;
  createdAt: string;
  video: { id: string; title: string } | null;
  creator: { id: string; displayName: string | null } | null;
}

const TYPE_LABELS: Record<string, string> = {
  PPV_PURCHASE: "Video purchase",
  SUBSCRIPTION: "Subscription",
  WALLET_TOPUP: "Wallet top-up",
  TIP: "Tip",
  PLATFORM_FEE: "Platform fee",
  REFERRAL_BONUS: "Referral bonus",
};

export default function BillingPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { format } = useCurrency();
  const { theme } = useTheme();
  const isLight = theme === "light";

  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [balance, setBalance] = useState(0);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // Cancelling a membership is irreversible for the billing period, so it asks
  // for confirmation in an in-app modal instead of a native window.confirm.
  const [pendingCancel, setPendingCancel] = useState<Subscription | null>(null);
  const [togglingRenew, setTogglingRenew] = useState<string | null>(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const [meRes, subRes, txRes] = await Promise.all([
        fetchCurrentUser(),
        fetch("/api/subscriptions"),
        fetch("/api/wallet/transactions"),
      ]);

      const me = await meRes.json();
      if (!me?.success) {
        router.push("/login");
        return;
      }
      setBalance(me.data.walletBalance || 0);

      const subs = await subRes.json();
      if (subs?.success) setSubscriptions(subs.data || []);

      const txs = await txRes.json();
      if (txs?.success) setTransactions(Array.isArray(txs.data) ? txs.data : []);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  async function cancelSubscription(sub: Subscription) {
    const name = sub.creator.displayName || "this creator";
    setPendingCancel(null);
    setCancelling(sub.creator.id);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId: sub.creator.id }),
      });
      const data = await res.json();

      if (data.success) {
        toast("success", `Subscription to ${name} cancelled`);
        setSubscriptions((prev) => prev.filter((s) => s.creator.id !== sub.creator.id));
      } else {
        toast("error", data.error || "Could not cancel the subscription");
      }
    } catch {
      toast("error", "Could not cancel the subscription");
    } finally {
      setCancelling(null);
    }
  }

  async function setAutoRenew(sub: Subscription, autoRenew: boolean) {
    setTogglingRenew(sub.creator.id);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorId: sub.creator.id, autoRenew }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", data.message || "Renewal setting updated");
        setSubscriptions((prev) =>
          prev.map((s) =>
            s.creator.id === sub.creator.id
              ? { ...s, autoRenew, renewAttempts: 0, lastRenewError: null }
              : s
          )
        );
      } else {
        toast("error", data.error || "Could not update the renewal setting");
      }
    } catch {
      toast("error", "Could not update the renewal setting");
    } finally {
      setTogglingRenew(null);
    }
  }

  const muted = isLight ? "text-gray-500" : "text-white/50";
  const heading = isLight ? "text-gray-900" : "text-white";

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div>
          <h1 className={cn("text-2xl font-display font-bold flex items-center gap-3", heading)}>
            <CreditCard className="w-6 h-6 text-brand-400" /> Billing &amp; Memberships
          </h1>
          <p className={cn("text-sm mt-1", muted)}>
            Manage your memberships, wallet balance and payment history. Memberships
            renew automatically — from your wallet when it covers the price, otherwise
            with a USSD prompt on the number you paid with.
          </p>
        </div>

        {/* Wallet */}
        <section className="glass-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-brand-500/20 flex items-center justify-center">
              <Wallet className="w-5 h-5 text-brand-400" />
            </div>
            <div>
              <p className={cn("text-xs uppercase tracking-wide", muted)}>Wallet balance</p>
              <p className={cn("text-2xl font-bold", heading)}>
                {loading ? "—" : format(balance)}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/wallet" className="btn-ghost flex items-center gap-2 text-sm">
              <RefreshCcw className="w-4 h-4" /> Top up
            </Link>
            <Link href="/wallet" className="btn-brand flex items-center gap-2 text-sm">
              Wallet <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

        {/* Subscriptions */}
        <section className="space-y-3">
          <h2 className={cn("font-display font-bold text-lg", heading)}>Active memberships</h2>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="skeleton h-20 rounded-xl" />
              ))}
            </div>
          ) : subscriptions.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <CreditCard className={cn("w-10 h-10 mx-auto mb-3", isLight ? "text-gray-300" : "text-white/15")} />
              <p className={cn("text-sm", muted)}>
                No active memberships — subscribe to a creator to unlock their full library.
              </p>
              <Link href="/creators" className="btn-brand inline-flex items-center gap-2 mt-4 text-sm">
                Browse creators <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {subscriptions.map((sub) => (
                <div
                  key={sub.id}
                  className="glass-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-medium overflow-hidden">
                      {sub.creator.avatarUrl ? (
                        <Image
                          src={sub.creator.avatarUrl}
                          alt={sub.creator.displayName || "Creator"}
                          width={40}
                          height={40}
                          unoptimized={!canOptimizeImage(sub.creator.avatarUrl)}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        sub.creator.displayName?.[0] || "C"
                      )}
                    </div>
                    <div>
                      <p className={cn("font-medium", heading)}>
                        {sub.creator.displayName || "Creator"}
                      </p>
                      <p className={cn("text-xs", muted)}>
                        {format(sub.price)}/month ·{" "}
                        {sub.autoRenew ? "renews automatically on " : "ends on "}
                        {new Date(sub.expiresAt).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                      {(sub.renewAttempts ?? 0) > 0 && sub.lastRenewError && (
                        <p className="text-xs text-amber-400 mt-1 flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          <span>
                            Renewal failed: {sub.lastRenewError}.{" "}
                            <Link href="/payments" className="underline">
                              Pay manually
                            </Link>
                          </span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setAutoRenew(sub, !sub.autoRenew)}
                      disabled={togglingRenew === sub.creator.id}
                      aria-pressed={sub.autoRenew}
                      title={
                        sub.autoRenew
                          ? "Stop renewing automatically when the period ends"
                          : "Renew automatically before it expires"
                      }
                      className={cn(
                        "text-sm flex items-center gap-1.5 px-3 py-2 rounded-xl border transition disabled:opacity-50",
                        sub.autoRenew
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                          : cn(
                              "border-white/10",
                              isLight
                                ? "text-gray-600 hover:bg-black/5"
                                : "text-white/60 hover:bg-white/5"
                            )
                      )}
                    >
                      {togglingRenew === sub.creator.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="w-4 h-4" />
                      )}
                      {sub.autoRenew ? "Auto-renew on" : "Auto-renew off"}
                    </button>
                    <Link
                      href={`/creator/${sub.creator.id}`}
                      className="btn-ghost text-sm flex items-center gap-1.5"
                    >
                      View creator
                    </Link>
                    <button
                      onClick={() => setPendingCancel(sub)}
                      disabled={cancelling === sub.creator.id}
                      className="btn-ghost text-sm flex items-center gap-1.5 text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      {cancelling === sub.creator.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <AlertTriangle className="w-4 h-4" />
                      )}
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Payment history */}
        <section className="space-y-3">
          <h2 className={cn("font-display font-bold text-lg flex items-center gap-2", heading)}>
            <ReceiptText className="w-5 h-5 text-brand-400" /> Payment history
          </h2>

          {loading ? (
            <div className="skeleton h-40 rounded-xl" />
          ) : transactions.length === 0 ? (
            <p className={cn("text-sm", muted)}>No transactions yet.</p>
          ) : (
            <div className="glass-card overflow-hidden">
              <div className="divide-y divide-white/5">
                {transactions.map((tx) => (
                  <div key={tx.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium truncate", heading)}>
                        {TYPE_LABELS[tx.type] || tx.type}
                        {tx.video?.title ? ` — ${tx.video.title}` : ""}
                        {!tx.video && tx.creator?.displayName ? ` — ${tx.creator.displayName}` : ""}
                      </p>
                      <p className={cn("text-xs", muted)}>
                        {formatRelativeTime(new Date(tx.createdAt))}
                        {tx.gateway ? ` · ${tx.gateway}` : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={cn("text-sm font-semibold", heading)}>{format(tx.amount)}</p>
                      <p
                        className={cn(
                          "text-xs",
                          tx.status === "SUCCESS"
                            ? "text-emerald-400"
                            : tx.status === "PENDING"
                              ? "text-amber-400"
                              : "text-red-400"
                        )}
                      >
                        {tx.status}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
      <BottomNav />

      {/* Cancel confirmation */}
      {pendingCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingCancel(null)}
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
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h2 className={cn("font-display font-bold", heading)}>Cancel membership?</h2>
              </div>
              <button
                onClick={() => setPendingCancel(null)}
                aria-label="Close"
                className={cn("p-1 rounded-lg transition", muted, "hover:opacity-70")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className={cn("text-sm mt-3", muted)}>
              Your membership with {pendingCancel.creator.displayName || "this creator"} ends on{" "}
              {new Date(pendingCancel.expiresAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              . Automatic renewal is switched off, you keep full access until then,
              and you can subscribe again any time.
            </p>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setPendingCancel(null)} className="btn-ghost flex-1">
                Keep membership
              </button>
              <button
                onClick={() => cancelSubscription(pendingCancel)}
                className="btn-brand flex-1 bg-red-500 hover:bg-red-600"
              >
                Cancel membership
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
