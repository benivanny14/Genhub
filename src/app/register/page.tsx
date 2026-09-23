"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { Play, Mail, Phone, Lock, Eye, EyeOff, User, Film } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function RegisterPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const isLight = theme === "light";
  const [role, setRole] = useState<"VIEWER" | "CREATOR">("VIEWER");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [referralCode, setReferralCode] = useState("");

  // Capture ?ref= affiliate code and ?role= creator pref from the URL
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref");
      if (ref) {
        setReferralCode(ref.toUpperCase());
        localStorage.setItem("genhub_ref", ref.toUpperCase());
      } else {
        const saved = localStorage.getItem("genhub_ref");
        if (saved) setReferralCode(saved);
      }
      if (params.get("role") === "creator") setRole("CREATOR");
    } catch {}
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          email: email || undefined,
          phone: phone || undefined,
          password,
          role,
          locale: "en",
          referralCode: referralCode || undefined,
        }),
      });

      const data = await res.json();

      if (data.success) {
        if (role === "CREATOR") {
          router.push("/creator/kyc");
        } else {
          router.push("/");
        }
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

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mb-4 glow-brand">
              <Play className="w-8 h-8 text-white fill-white" />
            </div>
            <h1 className="text-2xl font-display font-bold">{t("auth.joinGenhub")}</h1>
            <p className={cn("text-sm mt-2", isLight ? "text-gray-500" : "text-white/50")}>
              {t("auth.signUpDesc")}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">
                {error}
              </div>
            )}

            {/* Role Selection */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setRole("VIEWER")}
                className={cn(
                  "p-4 rounded-xl border text-center transition",
                  role === "VIEWER" ? "border-brand-500 bg-brand-500/10" : isLight ? "border-gray-200 hover:border-gray-300" : "border-white/10 hover:border-white/30"
                )}
              >
                <User className={cn("w-6 h-6 mx-auto mb-2", role === "VIEWER" ? "text-brand-400" : isLight ? "text-gray-400" : "text-white/40")} />
                <span className={cn("text-sm font-medium", role === "VIEWER" ? "text-brand-400" : isLight ? "text-gray-500" : "text-white/60")}>
                  {t("auth.viewer")}
                </span>
                <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>{t("auth.viewerDesc")}</p>
              </button>
              <button
                type="button"
                onClick={() => setRole("CREATOR")}
                className={cn(
                  "p-4 rounded-xl border text-center transition",
                  role === "CREATOR" ? "border-brand-500 bg-brand-500/10" : isLight ? "border-gray-200 hover:border-gray-300" : "border-white/10 hover:border-white/30"
                )}
              >
                <Film className={cn("w-6 h-6 mx-auto mb-2", role === "CREATOR" ? "text-brand-400" : isLight ? "text-gray-400" : "text-white/40")} />
                <span className={cn("text-sm font-medium", role === "CREATOR" ? "text-brand-400" : isLight ? "text-gray-500" : "text-white/60")}>
                  {t("auth.creator")}
                </span>
                <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>{t("auth.creatorDesc")}</p>
              </button>
            </div>

            <div className="relative">
              <User className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("auth.displayName")} className="input-field pl-10" required minLength={2} />
            </div>

            <div className="relative">
              <Mail className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailOptional")} className="input-field pl-10" />
            </div>

            <div className="relative">
              <Phone className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("auth.phoneOptional")} className="input-field pl-10" />
            </div>

            <p className={cn("text-xs -mt-3", isLight ? "text-gray-400" : "text-white/40")}>
              {t("auth.bothHint")}
            </p>

            <div className="relative">
              <Lock className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.passwordPlaceholder")}
                className="input-field pl-10 pr-10"
                required
                minLength={8}
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className={cn("absolute right-3 top-1/2 -translate-y-1/2 hover:text-gray-900", isLight ? "text-gray-400" : "text-white/40")}>
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <div className="relative">
              <Lock className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder={t("auth.confirmPassword")} className="input-field pl-10" required />
            </div>

            <button type="submit" disabled={loading} className="btn-brand w-full">
              {loading ? t("auth.creating") : t("auth.createAccount")}
            </button>

            {role === "CREATOR" && (
              <p className="text-xs text-amber-400/80 text-center">
                {t("auth.kycWarning")}
              </p>
            )}

            {/* Referral code */}
            <div>
              <label className={cn("text-xs mb-1 block", isLight ? "text-gray-400" : "text-white/40")}>
                Referral code (optional)
              </label>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                placeholder="e.g. AMANI2X9K"
                className="input-field uppercase"
                maxLength={32}
              />
              {referralCode && (
                <p className="text-xs text-emerald-400 mt-1">✓ Code applied — you both get a bonus</p>
              )}
            </div>

            <p className={cn("text-center text-sm", isLight ? "text-gray-500" : "text-white/50")}>
              {t("auth.hasAccount")}{" "}
              <Link href="/login" className="text-brand-400 hover:underline font-medium">
                {t("auth.signInHere")}
              </Link>
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
