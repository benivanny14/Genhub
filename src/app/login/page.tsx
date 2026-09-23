"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { Play, Mail, Phone, Lock, Eye, EyeOff } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const isLight = theme === "light";
  const [loginType, setLoginType] = useState<"email" | "phone">("phone");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
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
        router.push("/");
        router.refresh();
      } else {
        setError(data.error || t("common.error"));
      }
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setLoading(false);
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
        router.push(account === "creator" ? "/creator" : account === "admin" ? "/admin" : "/");
        router.refresh();
      } else {
        setError(data.error || "Demo login failed");
      }
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setDemoLoading(null);
    }
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mb-4 glow-brand">
              <Play className="w-8 h-8 text-white fill-white" />
            </div>
            <h1 className="text-2xl font-display font-bold">{t("auth.welcomeBack")}</h1>
            <p className={cn("text-sm mt-2", isLight ? "text-gray-500" : "text-white/50")}>
              {t("auth.signInDesc")}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">
                {error}
              </div>
            )}

            <div className={cn("flex rounded-xl p-1", isLight ? "bg-gray-100" : "bg-surface-300/40")}>
              <button
                type="button"
                onClick={() => setLoginType("phone")}
                className={cn(
                  "flex-1 py-2 rounded-lg text-sm font-medium transition",
                  loginType === "phone" ? "bg-brand-500 text-white" : isLight ? "text-gray-500" : "text-white/60"
                )}
              >
                {t("auth.phone")}
              </button>
              <button
                type="button"
                onClick={() => setLoginType("email")}
                className={cn(
                  "flex-1 py-2 rounded-lg text-sm font-medium transition",
                  loginType === "email" ? "bg-brand-500 text-white" : isLight ? "text-gray-500" : "text-white/60"
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
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={cn("absolute right-3 top-1/2 -translate-y-1/2 hover:text-gray-900", isLight ? "text-gray-400" : "text-white/40")}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <button type="submit" disabled={loading} className="btn-brand w-full">
              {loading ? t("auth.signingIn") : t("auth.signIn")}
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
                <button
                  onClick={() => demoLogin("creator")}
                  disabled={!!demoLoading}
                  className="btn-ghost flex-1 text-sm disabled:opacity-50"
                >
                  {demoLoading === "creator" ? "Signing in..." : "👤 Demo Creator"}
                </button>
                <button
                  onClick={() => demoLogin("viewer")}
                  disabled={!!demoLoading}
                  className="btn-ghost flex-1 text-sm disabled:opacity-50"
                >
                  {demoLoading === "viewer" ? "Signing in..." : "👥 Demo Viewer"}
                </button>
                <button
                  onClick={() => demoLogin("admin")}
                  disabled={!!demoLoading}
                  className="btn-ghost flex-1 text-sm disabled:opacity-50"
                >
                  {demoLoading === "admin" ? "Signing in..." : "🛡️ Demo Admin"}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
