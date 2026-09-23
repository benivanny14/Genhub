"use client";

// =============================================================================
// GENHUB - My Payments
// Every HarakaPay charge the signed-in customer has started, in one place:
// pending (waiting for the USSD PIN), completed, failed, and UNDER
// INVESTIGATION — the awkward one, where the customer approved the prompt but
// the gateway never settled, so the money may already have left their handset.
//
// That last state is deliberately NOT shown as "failed": a retry button next to
// a charge that might already have been paid for is how someone pays twice.
// Those rows say "do not pay again" and point at support instead.
// =============================================================================

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { useCurrency } from "@/lib/currency";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  CreditCard,
  Loader2,
  RefreshCcw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Hourglass,
  Phone,
  RotateCcw,
  X,
  ReceiptText,
  PlayCircle,
  Wallet,
} from "lucide-react";

interface PaymentTransaction {
  id: string;
  amount: number;
  type: string;
  status: string;
  gateway: string | null;
  providerRef: string | null;
  metadata: {
    expired?: boolean;
    gatewayError?: string;
    investigation?: boolean;
    reason?: string;
    refunded?: boolean;
    refundDestination?: "WALLET" | "GATEWAY";
    refundReason?: string;
    gatewayReversalRef?: string;
    /** False when the charge never settled, so nothing was ever unlocked. */
    settledBefore?: boolean;
  } | null;
  createdAt: string;
  videoId: string | null;
  creatorId: string | null;
  video: { id: string; title: string } | null;
  creator: { id: string; displayName: string | null } | null;
}

type Filter =
  | "all"
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "UNDER_INVESTIGATION"
  | "REFUNDED";

const TYPE_LABELS: Record<string, string> = {
  PPV_PURCHASE: "Video purchase",
  SUBSCRIPTION: "Subscription",
  WALLET_TOPUP: "Wallet top-up",
  TIP: "Tip",
  PLATFORM_FEE: "Platform fee",
  REFERRAL_BONUS: "Referral bonus",
};

// Charges the customer can start again straight from this page. Each maps to
// the endpoint that re-initiates it with only a phone number needed.
const RETRY_ENDPOINT: Record<string, string> = {
  PPV_PURCHASE: "/api/payments/purchase",
  WALLET_TOPUP: "/api/payments/topup",
  SUBSCRIPTION: "/api/subscriptions",
};

export default function PaymentsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { format } = useCurrency();
  const { theme } = useTheme();
  const isLight = theme === "light";

  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<PaymentTransaction[]>([]);
  const [walletBalance, setWalletBalance] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [walletPaying, setWalletPaying] = useState<string | null>(null);

  // Retry flow: ask for the phone number, then re-run the same checkout.
  const [retryTarget, setRetryTarget] = useState<PaymentTransaction | null>(null);
  const [retryPhone, setRetryPhone] = useState("");
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await fetch("/api/auth/me").then((r) => r.json());
      if (!me?.success) {
        router.push("/login");
        return;
      }
      setWalletBalance(me.data.walletBalance || 0);
      const res = await fetch("/api/wallet/transactions");
      const data = await res.json();
      if (data?.success) setTransactions(Array.isArray(data.data) ? data.data : []);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll our status endpoint until the charge settles (it reconciles with
  // HarakaPay server-side, so a missed webhook does not strand the payment).
  function pollOrder(orderId: string, attempt = 0) {
    if (attempt >= 40) {
      toast("warning", "Payment is still processing — refresh in a minute.");
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/status/${orderId}`);
        const data = await res.json();
        if (!data?.success) return pollOrder(orderId, attempt + 1);

        const status = data.data.status;
        if (status === "SUCCESS") {
          toast("success", "Payment complete 🎉");
          load();
          return;
        }
        if (status === "FAILED") {
          toast("error", "Payment failed or was cancelled.");
          load();
          return;
        }
        if (status === "UNDER_INVESTIGATION") {
          // Stop polling: this charge is no longer a "wait for the PIN" case,
          // it is a "we owe you an answer" case. Retrying the loop would only
          // tell the customer something we do not know.
          toast(
            "warning",
            "We are still checking this payment with your network — please do not pay again."
          );
          load();
          return;
        }
        pollOrder(orderId, attempt + 1);
      } catch {
        pollOrder(orderId, attempt + 1);
      }
    }, 3000);
  }

  async function checkStatus(tx: PaymentTransaction) {
    const orderId = tx.providerRef || tx.id;
    setCheckingId(tx.id);
    try {
      const res = await fetch(`/api/payments/status/${orderId}`);
      const data = await res.json();
      if (!data?.success) {
        toast("error", data?.error || "Could not read the payment status");
        return;
      }
      const status = data.data.status;
      if (status === "SUCCESS") toast("success", "This payment has completed 🎉");
      else if (status === "FAILED") toast("error", "This payment failed or expired.");
      else if (status === "UNDER_INVESTIGATION")
        toast(
          "warning",
          "We are checking this charge with your network — please do not pay again."
        );
      else toast("info", "Still waiting for the PIN on your phone.");
      await load();
    } catch {
      toast("error", "Network error — try again");
    } finally {
      setCheckingId(null);
    }
  }

  // Wallet fallback: pay for the same video from the balance the customer
  // already holds, instead of retrying the phone charge. Server-side this is
  // one atomic charge + 70/30 split + unlock.
  async function payFromWallet(tx: PaymentTransaction) {
    if (!tx.videoId) return;
    setWalletPaying(tx.id);
    try {
      const res = await fetch("/api/payments/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: tx.videoId, method: "WALLET" }),
      });
      const data = await res.json();

      if (data.success) {
        toast(
          "success",
          `${data.data?.message || "Paid from your wallet"} — new balance ${format(data.data?.newBalance ?? 0)}`
        );
        load();
        return;
      }

      toast("error", data.error || "Could not pay from your wallet");
      load();
    } catch {
      toast("error", "Network error — check your connection and try again");
    } finally {
      setWalletPaying(null);
    }
  }

  function retryBody(tx: PaymentTransaction, phoneNumber: string) {
    switch (tx.type) {
      case "PPV_PURCHASE":
        return { videoId: tx.videoId, phoneNumber };
      case "WALLET_TOPUP":
        return { amount: tx.amount, phoneNumber };
      case "SUBSCRIPTION":
        return { creatorId: tx.creatorId, phoneNumber };
      default:
        return null;
    }
  }

  async function submitRetry() {
    const tx = retryTarget;
    if (!tx) return;

    const endpoint = RETRY_ENDPOINT[tx.type];
    const body = retryBody(tx, retryPhone.trim());
    if (!endpoint || !body) {
      toast("error", "This charge cannot be retried here — open the video or creator page.");
      return;
    }

    setRetrying(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.success && data.data?.sandbox) {
        // Local dev: settle through the same processor production uses.
        const done = await fetch("/api/dev/sandbox/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: data.data.orderId }),
        }).then((r) => r.json());
        toast(
          done.success ? "success" : "error",
          done.success ? "Payment complete 🎉" : done.error || "Payment failed"
        );
        setRetryTarget(null);
        setRetryPhone("");
        load();
        return;
      }

      if (data.success) {
        const orderId: string | undefined = data.data?.orderId;
        setRetryTarget(null);
        setRetryPhone("");
        toast("info", "Check your phone — approve the HarakaPay prompt with your PIN.");
        if (orderId) pollOrder(orderId);
        else load();
        return;
      }

      toast("error", data.error || "Could not start the payment again");
      // The row may have been marked FAILED server-side; refresh to show it.
      load();
    } catch {
      toast("error", "Network error — check your connection and try again");
    } finally {
      setRetrying(false);
    }
  }

  const counts = {
    all: transactions.length,
    PENDING: transactions.filter((t) => t.status === "PENDING").length,
    SUCCESS: transactions.filter((t) => t.status === "SUCCESS").length,
    FAILED: transactions.filter((t) => t.status === "FAILED").length,
    UNDER_INVESTIGATION: transactions.filter((t) => t.status === "UNDER_INVESTIGATION")
      .length,
    REFUNDED: transactions.filter((t) => t.status === "REFUNDED").length,
  };

  const visible = transactions.filter((t) => filter === "all" || t.status === filter);
  const investigating = counts.UNDER_INVESTIGATION;

  const muted = isLight ? "text-gray-500" : "text-white/50";
  const heading = isLight ? "text-gray-900" : "text-white";

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "PENDING", label: "Pending" },
    { key: "SUCCESS", label: "Completed" },
    { key: "FAILED", label: "Failed" },
    { key: "UNDER_INVESTIGATION", label: "Being checked" },
    { key: "REFUNDED", label: "Refunded" },
  ];

  function StatusBadge({ tx }: { tx: PaymentTransaction }) {
    const expired = tx.status === "FAILED" && tx.metadata?.expired === true;
    const map: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
      SUCCESS: {
        label: "Completed",
        className: "bg-emerald-500/15 text-emerald-400",
        Icon: CheckCircle2,
      },
      PENDING: { label: "Pending", className: "bg-amber-500/15 text-amber-400", Icon: Clock },
      UNDER_INVESTIGATION: {
        label: "Being checked",
        className: "bg-amber-500/15 text-amber-400",
        Icon: Hourglass,
      },
      REFUNDED: {
        label: "Refunded",
        className: "bg-sky-500/15 text-sky-400",
        Icon: RotateCcw,
      },
      FAILED: {
        label: expired ? "Expired" : "Failed",
        className: "bg-red-500/15 text-red-400",
        Icon: XCircle,
      },
    };
    const entry = map[tx.status] ?? {
      label: tx.status,
      className: "bg-white/10 text-white/60",
      Icon: Clock,
    };
    const { Icon } = entry;

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          entry.className
        )}
      >
        <Icon className="w-3 h-3" /> {entry.label}
      </span>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className={cn("text-2xl font-display font-bold flex items-center gap-3", heading)}>
            <ReceiptText className="w-6 h-6 text-brand-400" /> My Payments
          </h1>
          <p className={cn("text-sm mt-1", muted)}>
            Every HarakaPay charge you started — pending, completed, failed and being
            checked.
          </p>
          <p className={cn("text-xs mt-2 inline-flex items-center gap-1.5", muted)}>
            <Wallet className="w-3.5 h-3.5" /> Wallet balance: {format(walletBalance)}
          </p>
        </div>

        {/* The one thing a customer must not get wrong: an unconfirmed charge may
            already have taken their money. Say so loudly, at the top, once. */}
        {investigating > 0 && (
          <div
            className={cn(
              "rounded-xl border p-4 flex items-start gap-3",
              isLight
                ? "border-amber-300 bg-amber-50"
                : "border-amber-500/30 bg-amber-500/10"
            )}
            role="status"
          >
            <Hourglass className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-400">
                {investigating === 1
                  ? "1 payment is being checked with your network"
                  : `${investigating} payments are being checked with your network`}
              </p>
              <p className={cn("mt-1", muted)}>
                Your mobile operator confirmed the request, but the money has not reached
                us yet. <strong>Please do not pay again</strong> — if the money did leave
                your phone we will unlock your purchase, and if it did not we will release
                the charge so you can retry. This is usually resolved within 24 hours.
              </p>
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "px-3 py-1.5 rounded-full text-sm font-medium border transition",
                filter === f.key
                  ? "border-brand-500 bg-brand-500/10 text-brand-400"
                  : isLight
                    ? "border-gray-200 text-gray-500 hover:border-gray-300"
                    : "border-white/10 text-white/60 hover:border-white/30"
              )}
            >
              {f.label}
              <span className="ml-1.5 opacity-70">{counts[f.key]}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="glass-card p-10 text-center">
            <CreditCard
              className={cn("w-10 h-10 mx-auto mb-3", isLight ? "text-gray-300" : "text-white/15")}
            />
            <p className={cn("text-sm", muted)}>
              {transactions.length === 0
                ? "No payments yet — buy a video or top up your wallet to get started."
                : "Nothing in this filter."}
            </p>
            {transactions.length === 0 && (
              <Link href="/" className="btn-brand inline-flex items-center gap-2 mt-4 text-sm">
                Browse videos
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((tx) => {
              const retryable = tx.status === "FAILED" && !!RETRY_ENDPOINT[tx.type];
              return (
                <div key={tx.id} className="glass-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium truncate", heading)}>
                        {TYPE_LABELS[tx.type] || tx.type}
                        {tx.video?.title ? ` — ${tx.video.title}` : ""}
                        {!tx.video && tx.creator?.displayName ? ` — ${tx.creator.displayName}` : ""}
                      </p>
                      <p className={cn("text-xs mt-0.5", muted)}>
                        {formatRelativeTime(new Date(tx.createdAt))}
                        {tx.gateway ? ` · ${tx.gateway}` : ""}
                        {tx.providerRef ? ` · ${tx.providerRef}` : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0 space-y-1">
                      <p className={cn("text-sm font-semibold", heading)}>{format(tx.amount)}</p>
                      <StatusBadge tx={tx} />
                    </div>
                  </div>

                  {tx.status === "PENDING" && (
                    <p className={cn("text-xs", muted)}>
                      Waiting for you to approve the USSD prompt on your phone.
                    </p>
                  )}

                  {/* Under investigation: the operator confirmed the request but we
                      never received the money. Deliberately offers no retry — a
                      second payment for a charge that may already be paid is the
                      exact mistake this state exists to prevent. */}
                  {tx.status === "UNDER_INVESTIGATION" && (
                    <div
                      className={cn(
                        "rounded-lg border p-3 flex items-start gap-2",
                        isLight
                          ? "border-amber-300 bg-amber-50"
                          : "border-amber-500/30 bg-amber-500/10"
                      )}
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-xs">
                        <p className="font-semibold text-amber-400">
                          We are checking this with your network — do not pay again.
                        </p>
                        <p className={cn("mt-1", muted)}>
                          You approved this charge but we have not received the money.
                          Paying again could charge you twice for the same thing. We will
                          unlock it automatically if the payment lands, or release it so
                          you can try again. Contact support if it is not sorted within 24
                          hours and quote {tx.providerRef || tx.id}.
                        </p>
                      </div>
                    </div>
                  )}

                  {tx.status === "FAILED" && tx.metadata?.gatewayError && (
                    <p className="text-xs text-red-400/80">
                      Gateway said: {tx.metadata.gatewayError}
                    </p>
                  )}
                  {tx.status === "FAILED" &&
                    tx.metadata?.expired === true &&
                    tx.metadata?.reason === "resolved_not_paid" && (
                      <p className={cn("text-xs", muted)}>
                        We checked with the network and the money never moved — it is safe
                        to try again.
                      </p>
                    )}

                  {/* Where a refund actually went. "Refunded" alone means two
                      different things here, and the customer needs to know which
                      one so they do not go looking in the wrong place. */}
                  {tx.status === "REFUNDED" && (
                    <div
                      className={cn(
                        "rounded-lg border p-3 flex items-start gap-2",
                        isLight
                          ? "border-sky-300 bg-sky-50"
                          : "border-sky-500/30 bg-sky-500/10"
                      )}
                    >
                      <RotateCcw className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                      <div className="text-xs">
                        <p className="font-semibold text-sky-400">Refunded</p>
                        <p className={cn("mt-1", muted)}>
                          {tx.metadata?.refundDestination === "GATEWAY"
                            ? `The money is being returned to the number you paid from. It can take up to 48 hours to reach your phone, and it will not show in your wallet.`
                            : tx.type === "WALLET_TOPUP"
                              ? "The credit was removed from your wallet and returned to the number you paid from."
                              : `TSh ${tx.amount.toLocaleString()} was added to your wallet — you can spend it straight away.`}
                          {/* Only say something was taken away if it ever existed:
                              a charge that never settled never unlocked anything. */}
                          {tx.metadata?.settledBefore !== false && tx.type === "PPV_PURCHASE"
                            ? " Access to the video has ended."
                            : ""}
                          {tx.metadata?.settledBefore !== false &&
                          tx.type === "SUBSCRIPTION"
                            ? " That membership has ended."
                            : ""}
                          {tx.metadata?.refundReason
                            ? ` Reason: ${tx.metadata.refundReason}`
                            : ""}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {(tx.status === "PENDING" ||
                      tx.status === "UNDER_INVESTIGATION") && (
                      <button
                        onClick={() => checkStatus(tx)}
                        disabled={checkingId === tx.id}
                        className="btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {checkingId === tx.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCcw className="w-4 h-4" />
                        )}
                        Check status
                      </button>
                    )}

                    {retryable && (
                      <button
                        onClick={() => {
                          setRetryTarget(tx);
                          setRetryPhone("");
                        }}
                        className="btn-brand text-sm flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-4 h-4" /> Retry payment
                      </button>
                    )}

                    {/* Wallet fallback — only a video purchase can be settled
                        from the balance, and the balance must cover it. */}
                    {retryable &&
                      tx.type === "PPV_PURCHASE" &&
                      tx.videoId &&
                      walletBalance >= tx.amount && (
                        <button
                          onClick={() => payFromWallet(tx)}
                          disabled={walletPaying === tx.id}
                          className="btn-ghost text-sm flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {walletPaying === tx.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Wallet className="w-4 h-4" />
                          )}
                          Pay {format(tx.amount)} from wallet
                        </button>
                      )}

                    {tx.status === "SUCCESS" && tx.type === "PPV_PURCHASE" && tx.videoId && (
                      <Link
                        href={`/video/${tx.videoId}`}
                        className="btn-ghost text-sm flex items-center gap-1.5"
                      >
                        <PlayCircle className="w-4 h-4" /> Watch
                      </Link>
                    )}

                    {tx.status === "SUCCESS" && tx.type === "WALLET_TOPUP" && (
                      <Link href="/wallet" className="btn-ghost text-sm flex items-center gap-1.5">
                        <CreditCard className="w-4 h-4" /> Wallet
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <BottomNav />

      {/* Retry modal */}
      {retryTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => (retrying ? null : setRetryTarget(null))}
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
                <RotateCcw className="w-5 h-5 text-brand-400" />
                <h2 className={cn("font-display font-bold", heading)}>Try this payment again</h2>
              </div>
              <button
                onClick={() => (retrying ? null : setRetryTarget(null))}
                aria-label="Close"
                className={cn("p-1 rounded-lg transition", muted, "hover:opacity-70")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className={cn("mt-3 text-sm space-y-1", muted)}>
              <p className={cn("font-medium", heading)}>
                {TYPE_LABELS[retryTarget.type] || retryTarget.type}
                {retryTarget.video?.title ? ` — ${retryTarget.video.title}` : ""}
                {!retryTarget.video && retryTarget.creator?.displayName
                  ? ` — ${retryTarget.creator.displayName}`
                  : ""}
              </p>
              <p>{format(retryTarget.amount)}</p>
            </div>

            <label className={cn("text-sm block mt-4 mb-2", muted)}>
              Phone number for the USSD prompt
            </label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="tel"
                value={retryPhone}
                onChange={(e) => setRetryPhone(e.target.value)}
                placeholder="07XX XXX XXX"
                className="input-field pl-10"
                autoFocus
              />
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setRetryTarget(null)}
                disabled={retrying}
                className="btn-ghost flex-1 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitRetry}
                disabled={retrying || retryPhone.trim().length < 9}
                className="btn-brand flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {retrying ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <AlertTriangle className="w-4 h-4" />
                )}
                Pay {format(retryTarget.amount)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
