"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import AuthBrandPanel from "@/components/AuthBrandPanel";
import { Play, Mail, Phone, Lock, Eye, EyeOff, Check, Loader2, ArrowRight } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import { safeInAppPath } from "@/lib/redirect";
import { forgetCurrentUser } from "@/lib/current-user";

/**
 * Where signing in should land.
 *
 * The middleware sends you here as `/login?redirect=/admin` when you ask for a
 * page that needs a session, and this page used to ignore it: you signed in and
 * arrived at the home page, so the page you were actually going to had to be
 * found again by hand — which is exactly the moment people give up.
 *
 * Read from `window.location` rather than `useSearchParams()`: that hook makes
 * this page need a Suspense boundary and fails the production build where it is
 * missing. The value is validated (see lib/redirect.ts) because it arrives in a
 * link somebody else can compose — an unchecked one is an open redirect.
 */
function landingPath(): string {
  if (typeof window === "undefined") return "/";
  return safeInAppPath(new URLSearchParams(window.location.search).get("redirect")) ?? "/";
}

/** The form's life cycle — each phase has its own look and motion. */
type Phase = "idle" | "loading" | "success" | "error";

export default function LoginPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const { toast } = useToast();
  const isLight = theme === "light";

  const [loginType, setLoginType] = useState<"email" | "phone">("phone");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the redirect timer if the page unmounts mid-success.
  useEffect(() => () => {
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
  }, []);

  /** Re-trigger the refusal animation even when the class is already applied. */
  function refuse(message: string) {
    setError(message);
    setPhase("error");
    setShaking(false);
    requestAnimationFrame(() => setShaking(true));
    toast("error", message);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "loading" || phase === "success") return;
    setPhase("loading");
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(loginType === "email" ? { email } : { phone }),
          password,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // The response the components are holding says "signed out". Drop it
        // before navigating, or the Header can paint the signed-out menu over a
        // session that now exists (lib/current-user.ts has a two-second window).
        forgetCurrentUser();
        setPhase("success");
        toast(
          "success",
          `Welcome back${data.data?.displayName ? `, ${data.data.displayName}` : ""}!`
        );
        // Let the acceptance animation land before the page changes.
        redirectTimer.current = setTimeout(() => {
          router.push(landingPath());
          router.refresh();
        }, 850);
      } else {
        setPhase("idle");
        refuse(data.error || t("common.error"));
      }
    } catch {
      setPhase("idle");
      refuse(t("auth.networkError"));
    }
  }

  const [demoLoading, setDemoLoading] = useState<string | null>(null);

  async function demoLogin(account: "creator" | "viewer" | "admin") {
    setDemoLoading(account);
    setError("");
    try {
      const res = await fetch("/api/auth/demo-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      const data = await res.json();
      if (data.success) {
        forgetCurrentUser();
        toast("success", `Signed in as the demo ${account}.`);
        router.push(account === "creator" ? "/creator" : account === "admin" ? "/admin" : "/");
        router.refresh();
      } else {
        refuse(data.error || "Demo login failed");
      }
    } catch {
      refuse(t("auth.networkError"));
    } finally {
      setDemoLoading(null);
    }
  }

  const busy = phase === "loading" || phase === "success";

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl">
        <AuthBrandPanel
          eyebrow="Members only"
          headline="The scenes everyone is talking about — unlocked in one tap."
          sub="Thousands of premium scenes from verified creators. Pay per scene or subscribe, watch in up to 4K, and keep your library forever."
          points={[
            "New releases every day from creators you love",
            "Pay with M-Pesa, Tigo Pesa, Airtel Money or card",
            "Your watch history and purchases, on every device",
          ]}
        />

        <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-md">
            {/* Compact brand header — the aurora panel is hidden on mobile */}
            <div className="mb-8 text-center lg:hidden">
              <div className="auth-float mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 glow-brand">
                <Play className="h-8 w-8 fill-white text-white" />
              </div>
            </div>
            <div className="auth-rise mb-8 text-center lg:text-left">
              <h1 className="font-display text-3xl font-bold">{t("auth.welcomeBack")}</h1>
              <p className={cn("mt-2 text-sm", isLight ? "text-gray-500" : "text-white/50")}>
                {t("auth.signInDesc")}
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              onAnimationEnd={() => setShaking(false)}
              className={cn(
                "glass-card relative overflow-hidden p-6 space-y-5",
                shaking && "auth-shake",
                phase === "error" && "border-red-500/40"
              )}
            >
              {/* Acceptance veil — the whole card confirms before it leaves */}
              {phase === "success" && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface-500/95 backdrop-blur">
                  <div className="auth-pop flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 ring-2 ring-emerald-400/60">
                    <Check className="h-8 w-8 text-emerald-400" />
                  </div>
                  <p className="font-display text-lg font-semibold">{t("auth.signIn")} ✓</p>
                  <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
                    Taking you in…
                  </p>
                </div>
              )}

              {error && (
                <div className="auth-rise flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">
                  <span className="mt-0.5">⚠</span>
                  <span>{error}</span>
                </div>
              )}

              {/* Method switch with a sliding pill */}
              <div
                className={cn(
                  "relative flex rounded-xl p-1",
                  isLight ? "bg-gray-100" : "bg-surface-300/40"
                )}
              >
                <span
                  className={cn(
                    "absolute inset-y-1 w-[calc(50%-4px)] rounded-lg bg-brand-500 shadow-lg shadow-brand-500/30 transition-transform duration-300 ease-out",
                    loginType === "email" ? "translate-x-[calc(100%+4px)]" : "translate-x-0"
                  )}
                />
                <button
                  type="button"
                  onClick={() => setLoginType("phone")}
                  className={cn(
                    "relative z-10 flex-1 py-2 rounded-lg text-sm font-medium transition-colors",
                    loginType === "phone" ? "text-white" : isLight ? "text-gray-500" : "text-white/60"
                  )}
                >
                  {t("auth.phone")}
                </button>
                <button
                  type="button"
                  onClick={() => setLoginType("email")}
                  className={cn(
                    "relative z-10 flex-1 py-2 rounded-lg text-sm font-medium transition-colors",
                    loginType === "email" ? "text-white" : isLight ? "text-gray-500" : "text-white/60"
                  )}
                >
                  {t("auth.email")}
                </button>
              </div>

              <div className="relative">
                {loginType === "email" ? (
                  <>
                    <Mail className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="input-field pl-10"
                      autoComplete="email"
                      required
                    />
                  </>
                ) : (
                  <>
                    <Phone className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="07XX XXX XXX"
                      className="input-field pl-10"
                      autoComplete="tel"
                      required
                    />
                  </>
                )}
              </div>

              <div className="relative">
                <Lock className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.password")}
                  className="input-field pl-10 pr-10"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className={cn("absolute right-3 top-1/2 -translate-y-1/2 hover:text-gray-900", isLight ? "text-gray-400" : "text-white/40")}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <button
                type="submit"
                disabled={busy}
                className={cn(
                  "btn-brand w-full inline-flex items-center justify-center gap-2",
                  phase === "loading" && "auth-busy"
                )}
              >
                {phase === "loading" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t("auth.signingIn")}
                  </>
                ) : phase === "success" ? (
                  <>
                    <Check className="w-4 h-4" />
                    {t("auth.signIn")}
                  </>
                ) : (
                  <>
                    {t("auth.signIn")}
                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </button>

              <div className="text-center text-sm space-y-2">
                <p>
                  <Link href="/forgot-password" className="text-brand-400/80 hover:text-brand-400 hover:underline">
                    {t("auth.forgotPassword")}
                  </Link>
                </p>
                <p className={isLight ? "text-gray-500" : "text-white/50"}>
                  {t("auth.noAccount")}{" "}
                  <Link href="/register" className="text-brand-400 hover:underline font-medium">
                    {t("auth.signUpNow")}
                  </Link>
                </p>
              </div>
            </form>

            {/* Dev-only demo logins */}
            {process.env.NODE_ENV !== "production" && (
              <div className={cn(
                "mt-4 rounded-2xl border p-4 text-center",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/10"
              )}>
                <p className={cn("text-xs mb-3", isLight ? "text-gray-500" : "text-white/40")}>
                  Development only — one-click sign in with seeded demo accounts
                </p>
                <div className="flex gap-2">
                  {(["creator", "viewer", "admin"] as const).map((account) => (
                    <button
                      key={account}
                      onClick={() => demoLogin(account)}
                      disabled={!!demoLoading}
                      className="btn-ghost flex-1 text-sm disabled:opacity-50"
                    >
                      {demoLoading === account
                        ? "Signing in…"
                        : account === "creator"
                          ? "👤 Demo Creator"
                          : account === "viewer"
                            ? "👥 Demo Viewer"
                            : "🛡️ Demo Admin"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
