"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import { useRouter } from "next/navigation";
import { Wallet, ArrowUpRight, ArrowDownLeft, Plus, History, Phone, Ticket } from "lucide-react";
import { formatTZS, formatRelativeTime } from "@/lib/utils";
import { useCurrency } from "@/lib/currency";
import { useToast } from "@/components/Toast";

interface UserData {
  id: string;
  displayName: string | null;
  walletBalance: number;
}

interface Transaction {
  id: string;
  amount: number;
  type: string;
  status: string;
  createdAt: string;
  video?: { title: string } | null;
}

export default function WalletPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(1000);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [topping, setTopping] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [couponInfo, setCouponInfo] = useState<{ bonus: number } | null>(null);
  const [couponError, setCouponError] = useState("");
  const { format } = useCurrency();
  const { toast } = useToast();

  // Live HarakaPay pushes a USSD prompt to the phone; the payment only settles
  // when the webhook (or our reconcile poll) marks the transaction SUCCESS. Poll
  // /api/payments/status until then so the wallet balance updates by itself.
  // ~2 minutes: entering a USSD PIN can easily take a minute on a slow network.
  function pollTopUp(transactionId: string, attempt = 0) {
    if (attempt >= 40) {
      toast("warning", "Payment is still processing — refresh the page in a minute.");
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/status/${transactionId}`);
        const data = await res.json();
        if (!data.success) return pollTopUp(transactionId, attempt + 1);
        const status = data.data.status;
        if (status === "SUCCESS") {
          toast("success", "Top-up complete — funds added to your wallet 🎉");
          fetchUserData();
          fetchTransactions();
          return;
        }
        if (status === "FAILED") {
          toast("error", "Payment failed or was cancelled. Please try again.");
          fetchTransactions();
          return;
        }
        if (status === "UNDER_INVESTIGATION") {
          // The PIN was accepted but the gateway never settled. We do not know
          // whether the money moved, so do not invite another top-up.
          toast(
            "warning",
            "We are checking this top-up with your network — please do not pay again."
          );
          fetchTransactions();
          return;
        }
        pollTopUp(transactionId, attempt + 1);
      } catch {
        pollTopUp(transactionId, attempt + 1);
      }
    }, 3000);
  }

  async function previewCoupon() {
    setCouponError("");
    setCouponInfo(null);
    if (!couponCode.trim()) return;
    try {
      const res = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: couponCode.trim(),
          amount: topUpAmount,
          context: "topup",
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCouponInfo({ bonus: data.data.bonus || 0 });
      } else {
        setCouponError(data.error || "Invalid coupon");
      }
    } catch {
      setCouponError("Could not check coupon");
    }
  }

  const fetchUserData = useCallback(async () => {
    try {
      const res = await fetchCurrentUser();
      const data = await res.json();
      if (data.success) {
        setUser(data.data);
      } else {
        router.push("/login");
      }
    } catch {
      router.push("/login");
    }
  }, [router]);

  const fetchTransactions = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet/transactions");
      const data = await res.json();
      if (data.success) {
        setTransactions(data.data);
      }
    } catch {
      // Use empty array
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUserData();
    fetchTransactions();
  }, [fetchUserData, fetchTransactions]);

  async function handleTopUp() {
    if (!phoneNumber || !topUpAmount) return;
    setTopping(true);

    try {
      const res = await fetch("/api/payments/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: topUpAmount,
          gateway: "HARAKAPAY",
          phoneNumber,
          couponCode: couponCode.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (data.success && data.data?.sandbox) {
        // Local dev: complete through the same webhook processor as production
        setShowTopUp(false);
        const done = await fetch("/api/dev/sandbox/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: data.data.orderId }),
        });
        const doneData = await done.json();
        if (doneData.success) {
          const bonusMsg =
            couponInfo && couponInfo.bonus > 0
              ? ` (+ TZS ${couponInfo.bonus.toLocaleString()} coupon bonus)`
              : "";
          toast("success", `Top-up complete${bonusMsg} — funds added to your wallet 🎉`);
        } else {
          toast("error", doneData.error || "Top-up failed");
        }
        setCouponCode("");
        setCouponInfo(null);
        fetchUserData();
        fetchTransactions();
      } else if (data.success) {
        // Live HarakaPay: USSD push sent — poll until the payment settles.
        const orderId: string | undefined = data.data?.orderId;
        setShowTopUp(false);
        setCouponCode("");
        setCouponInfo(null);
        toast(
          "info",
          "Check your phone — approve the HarakaPay prompt with your PIN to complete the top-up."
        );
        if (orderId) {
          pollTopUp(orderId);
        } else {
          fetchUserData();
        }
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Network error — check your connection and try again.");
    } finally {
      setTopping(false);
    }
  }

  const QUICK_AMOUNTS = [500, 1000, 2000, 5000, 10000, 20000];

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-lg mx-auto px-4 py-8 space-y-6">
        {/* Balance Card */}
        <div className="glass-card p-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-brand-500/20 flex items-center justify-center mb-4 glow-brand">
            <Wallet className="w-8 h-8 text-brand-400" />
          </div>
          <p className="text-white/50 text-sm mb-1">Wallet Balance</p>
          <p className="text-4xl font-display font-bold text-gradient">
            {format(user?.walletBalance || 0)}
          </p>
          <button
            onClick={() => setShowTopUp(true)}
            className="btn-brand mt-4 flex items-center gap-2 mx-auto"
          >
            <Plus className="w-4 h-4" /> Add Funds
          </button>
        </div>

        {/* Transaction History */}
        <div className="glass-card p-4">
          <h2 className="font-display font-bold mb-4 flex items-center gap-2">
            <History className="w-5 h-5 text-brand-400" /> Transaction History
          </h2>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-16 w-full" />
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-center text-white/40 py-8 text-sm">
              No transactions yet
            </p>
          ) : (
            <div className="space-y-3">
              {transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-surface-300/30"
                >
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      tx.type === "WALLET_TOPUP"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-amber-500/20 text-amber-400"
                    }`}
                  >
                    {tx.type === "WALLET_TOPUP" ? (
                      <ArrowDownLeft className="w-5 h-5" />
                    ) : (
                      <ArrowUpRight className="w-5 h-5" />
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {tx.type === "WALLET_TOPUP"
                        ? "Wallet Top-up"
                        : tx.type === "PPV_PURCHASE"
                        ? `Purchase: ${tx.video?.title || "Video"}`
                        : tx.type}
                    </p>
                    <p className="text-xs text-white/40">
                      {formatRelativeTime(new Date(tx.createdAt))}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`font-bold text-sm ${
                        tx.type === "WALLET_TOPUP" ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {tx.type === "WALLET_TOPUP" ? "+" : "-"}
                      {formatTZS(tx.amount)}
                    </p>
                    <p
                      className={`text-xs ${
                        tx.status === "SUCCESS"
                          ? "text-emerald-400"
                          : tx.status === "PENDING" || tx.status === "UNDER_INVESTIGATION"
                          ? "text-amber-400"
                          : "text-red-400"
                      }`}
                    >
                      {tx.status === "SUCCESS"
                        ? "Completed"
                        : tx.status === "PENDING"
                        ? "Pending"
                        : tx.status === "UNDER_INVESTIGATION"
                        ? "Being checked"
                        : "Failed"}
                    </p>
                    {tx.status === "UNDER_INVESTIGATION" && (
                      <p className="text-[11px] text-amber-400/80 mt-0.5">
                        Do not pay again
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Top-Up Modal */}
      {showTopUp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-card w-full max-w-md p-6 animate-slide-up">
            <h2 className="text-xl font-display font-bold mb-4">Add Funds</h2>

            <div className="space-y-4">
              {/* Quick Amount Buttons */}
              <div>
                <label className="text-sm text-white/60 mb-2 block">Amount</label>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  {QUICK_AMOUNTS.map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setTopUpAmount(amt)}
                      className={`p-2.5 rounded-xl text-sm font-medium border transition ${
                        topUpAmount === amt
                          ? "border-brand-500 bg-brand-500/10 text-brand-400"
                          : "border-white/10 text-white/60 hover:border-white/30"
                      }`}
                    >
                      {formatTZS(amt)}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(parseInt(e.target.value) || 0)}
                  min={500}
                  className="input-field"
                  placeholder="Custom amount..."
                />
              </div>

              {/* Payment method — HarakaPay USSD push (all networks) */}
              <div>
                <label className="text-sm text-white/60 mb-2 block">Payment Method</label>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-brand-500/30 bg-brand-500/10">
                  <Phone className="w-5 h-5 text-brand-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-400">HarakaPay</p>
                    <p className="text-xs text-white/50">
                      USSD push — Vodacom, Tigo &amp; Airtel supported. Confirm with your PIN.
                    </p>
                  </div>
                </div>
              </div>

              {/* Phone */}
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="Phone number"
                  className="input-field pl-10"
                />
              </div>

              {/* Coupon code */}
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
                    onClick={previewCoupon}
                    className="btn-ghost px-4 text-sm shrink-0"
                  >
                    Apply
                  </button>
                </div>
                {couponError && (
                  <p className="text-xs text-red-400 mt-1">{couponError}</p>
                )}
                {couponInfo && (
                  <p className="text-xs text-emerald-400 mt-1">
                    ✓ Bonus: +TZS {couponInfo.bonus.toLocaleString()} on this top-up
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={() => setShowTopUp(false)} className="btn-ghost flex-1">
                  Cancel
                </button>
                <button
                  onClick={handleTopUp}
                  disabled={topping || !phoneNumber || !topUpAmount}
                  className="btn-brand flex-1"
                >
                  {topping ? "Processing..." : `Pay ${formatTZS(topUpAmount)}`}
                </button>
              </div>
              {couponInfo && couponInfo.bonus > 0 && (
                <p className="text-center text-xs text-emerald-400">
                  You&apos;ll receive {formatTZS(topUpAmount + couponInfo.bonus)} in total
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
