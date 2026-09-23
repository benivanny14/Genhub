"use client";

// =============================================================================
// GENHUB - Become a Creator page
// Marketing pitch + onboarding stepper. The stepper adapts to the visitor:
//   visitor  -> sign up as creator
//   viewer   -> one-click upgrade to CREATOR, then KYC
//   creator  -> KYC or straight to the dashboard
// =============================================================================

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import {
  Sparkles,
  ArrowLeft,
  Upload,
  BadgeCheck,
  Wallet,
  TrendingUp,
  Users,
  Clapperboard,
  CheckCircle2,
  Circle,
  Loader2,
} from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

const BENEFITS = [
  {
    icon: Wallet,
    title: "Keep 70% of everything",
    body: "Every sale, subscription and tip splits 70/30 in your favor — with a 14-day holding period you can track in your dashboard.",
  },
  {
    icon: TrendingUp,
    title: "Real-time analytics",
    body: "Views, revenue mix, top videos and your biggest fans — updated live so you know exactly what sells.",
  },
  {
    icon: Users,
    title: "Subscriptions & tips",
    body: "Earn recurring income from subscribers plus one-off tips on every video, paid straight to mobile money.",
  },
  {
    icon: Sparkles,
    title: "Free to start",
    body: "No listing fees, no monthly cost. Upload your first video, set your own price in TZS, and start earning.",
  },
];

const STEPS = [
  { icon: Clapperboard, label: "Create your creator account", body: "One click if you already watch on Genhub." },
  { icon: BadgeCheck, label: "Verify your identity (KYC)", body: "NIDA or passport — required before uploading." },
  { icon: Upload, label: "Upload & price your content", body: "Set a price per video or go free to build an audience." },
  { icon: Wallet, label: "Get paid", body: "Payouts to M-Pesa, Tigo Pesa or Airtel Money from TZS 30,000." },
];

type AppState =
  | { kind: "loading" }
  | { kind: "guest" }
  | { kind: "banned" }
  | { kind: "viewer" }
  | { kind: "creator"; kyc: string }
  | { kind: "admin" };

interface AppStatus {
  step: string;
  role: string;
  kycStatus: string;
  nextPath: string | null;
}

export default function BecomeCreatorPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const { toast } = useToast();
  const isLight = theme === "light";

  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (res.status === 401) {
          if (!cancelled) setState({ kind: "guest" });
          return;
        }
        const me = await res.json();
        if (!me.success) {
          if (!cancelled) setState({ kind: "guest" });
          return;
        }
        const appRes = await fetch("/api/account/creator-application");
        const app = await appRes.json();
        if (!app.success) {
          if (!cancelled) setState({ kind: "guest" });
          return;
        }
        if (!cancelled) {
          setStatus(app.data);
          const role = app.data.role;
          if (role === "ADMIN") setState({ kind: "admin" });
          else if (role === "CREATOR") setState({ kind: "creator", kyc: app.data.kycStatus });
          else if (me.data.isBanned) setState({ kind: "banned" });
          else setState({ kind: "viewer" });
        }
      } catch {
        if (!cancelled) setState({ kind: "guest" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpgrade() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/become-creator", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast("success", "You're a creator now! Next: verify your identity.");
        router.push("/creator/kyc");
        router.refresh();
      } else {
        toast("error", data.error || "Could not upgrade your account");
      }
    } catch {
      toast("error", "Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  // Active step index for the visual stepper (0-3)
  const activeStep =
    state.kind === "guest" ? 0 : state.kind === "viewer" ? 0 : state.kind === "creator" && status?.kycStatus !== "APPROVED" ? 1 : 3;

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-brand-400 hover:text-brand-300 text-sm mb-6 transition"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>

        {/* Hero */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-brand-500/10 border border-brand-500/20 rounded-full px-4 py-1.5 mb-4 text-sm font-medium text-brand-400">
            <Sparkles className="w-4 h-4" /> Become a Creator
          </div>
          <h1 className="text-3xl md:text-5xl font-display font-bold mb-4">
            Share your content. <span className="text-gradient">Earn 70%.</span>
          </h1>
          <p className={cn("text-lg max-w-2xl mx-auto", isLight ? "text-gray-500" : "text-white/60")}>
            Musicians, comedians, educators and filmmakers across East Africa monetize
            their audience on Genhub — with payouts in shillings, straight to mobile money.
          </p>
        </div>

        {/* Status-aware CTA card */}
        <div className={cn("rounded-2xl border p-6 md:p-8 mb-10", isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5")}>
          {state.kind === "loading" && (
            <div className="flex items-center justify-center gap-3 py-6">
              <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
              <span className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>Checking your account…</span>
            </div>
          )}

          {state.kind === "guest" && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <h2 className="font-display font-bold text-lg">Ready to start?</h2>
                <p className={cn("text-sm mt-1", isLight ? "text-gray-500" : "text-white/50")}>
                  Create a creator account — it takes under a minute.
                </p>
              </div>
              <div className="flex gap-3 shrink-0">
                <Link href="/login" className="btn-ghost">
                  I have an account
                </Link>
                <Link href="/register?role=creator" className="btn-brand">
                  Sign up as creator
                </Link>
              </div>
            </div>
          )}

          {state.kind === "banned" && (
            <p className="text-sm text-red-400 text-center py-3">
              Your account is suspended and cannot become a creator. Contact support if you
              think this is a mistake.
            </p>
          )}

          {state.kind === "viewer" && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <h2 className="font-display font-bold text-lg">Upgrade your account</h2>
                <p className={cn("text-sm mt-1", isLight ? "text-gray-500" : "text-white/50")}>
                  You already watch on Genhub — switch to a creator account and verify your
                  ID to start uploading.
                </p>
              </div>
              <button onClick={handleUpgrade} disabled={submitting} className="btn-brand shrink-0 disabled:opacity-60">
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Upgrading…
                  </>
                ) : (
                  "Become a Creator"
                )}
              </button>
            </div>
          )}

          {state.kind === "creator" && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <h2 className="font-display font-bold text-lg flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" /> You&apos;re a creator
                </h2>
                <p className={cn("text-sm mt-1", isLight ? "text-gray-500" : "text-white/50")}>
                  {status?.kycStatus === "APPROVED"
                    ? "Your identity is verified — head to the dashboard to manage your content."
                    : status?.kycStatus === "PENDING"
                      ? "Your documents are under review. We'll notify you once they're approved."
                      : "Verify your identity (KYC) to unlock uploads and payouts."}
                </p>
              </div>
              <div className="flex gap-3 shrink-0">
                {status?.kycStatus !== "APPROVED" && (
                  <Link href="/creator/kyc" className="btn-ghost">
                    {status?.kycStatus === "PENDING" ? "View KYC status" : "Verify identity"}
                  </Link>
                )}
                <Link href="/creator" className="btn-brand">
                  Open dashboard
                </Link>
              </div>
            </div>
          )}

          {state.kind === "admin" && (
            <div className="flex items-center justify-between gap-4">
              <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
                Admin accounts already have full access.
              </p>
              <Link href="/admin" className="btn-brand">
                Open admin panel
              </Link>
            </div>
          )}
        </div>

        {/* Onboarding stepper */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {STEPS.map((step, i) => {
            const done = i < activeStep;
            const current = i === activeStep;
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className={cn(
                  "rounded-xl border p-4",
                  done
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : current
                      ? "border-brand-500/40 bg-brand-500/5"
                      : isLight
                        ? "border-gray-200 bg-white"
                        : "border-white/5 bg-surface-400/30"
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  {done ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  ) : current ? (
                    <Circle className="w-5 h-5 text-brand-400 fill-brand-500/30" />
                  ) : (
                    <Circle className={cn("w-5 h-5", isLight ? "text-gray-300" : "text-white/20")} />
                  )}
                  <Icon
                    className={cn(
                      "w-4 h-4 ml-auto",
                      done ? "text-emerald-400" : current ? "text-brand-400" : isLight ? "text-gray-300" : "text-white/20"
                    )}
                  />
                </div>
                <p className={cn("text-sm font-medium", done || current ? "" : isLight ? "text-gray-400" : "text-white/40")}>
                  {step.label}
                </p>
                <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>{step.body}</p>
              </div>
            );
          })}
        </div>

        {/* Benefits */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {BENEFITS.map((b) => {
            const Icon = b.icon;
            return (
              <div
                key={b.title}
                className={cn("rounded-2xl border p-6", isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5")}
              >
                <Icon className="w-6 h-6 text-brand-400 mb-3" />
                <h3 className="font-display font-bold mb-1">{b.title}</h3>
                <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>{b.body}</p>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
