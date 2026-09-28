"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import AuthBrandPanel from "@/components/AuthBrandPanel";
import { Play, Mail, Lock, Eye, EyeOff, User, AtSign, Film, Check, Loader2, ArrowRight, ScrollText, ShieldAlert } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import {
  CREATOR_GUIDELINES,
  GUIDELINE_ACK_LABEL_EN,
  GUIDELINE_ACK_LABEL_SW,
} from "@/lib/creator-guidelines";
import {
  USERNAME_RULES_HINT,
  normalizeUsername,
  usernameFromDisplayName,
} from "@/lib/usernames";

/** The form's life cycle — each phase has its own look and motion. */
type Phase = "idle" | "loading" | "success" | "error";

/** 0–4 estimate used only to nudge a better password, never to gate submit. */
function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}

const STRENGTH = [
  { label: "", color: "" },
  { label: "Weak", color: "bg-red-500" },
  { label: "Fair", color: "bg-amber-500" },
  { label: "Good", color: "bg-sky-500" },
  { label: "Strong", color: "bg-emerald-500" },
];

export default function RegisterPage() {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const { toast } = useToast();
  const isLight = theme === "light";

  const [role, setRole] = useState<"VIEWER" | "CREATOR">("VIEWER");
  const [displayName, setDisplayName] = useState("");
  // The public handle. Stored lowercase; typed as-is here so the person sees
  // their own keystrokes, and normalised again on submit and on the server.
  const [username, setUsername] = useState("");
  // True once the person has typed a handle of their own. Until then the field
  // follows the display name, so signing up does not ask for the same name
  // twice — and the moment they edit it, we stop moving it under their cursor.
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  // The creator guidelines. A creator agrees to these as part of signing up,
  // not at the upload screen — the rules include things that decide whether a
  // video can be made at all (on camera, at least 8 minutes long), so reading
  // them has to happen before any work is done. Each rule is ticked
  // individually: one "I agree" under a wall of text is how people accept rules
  // they never read, and two of these cost a creator their account.
  const [guidelineChecks, setGuidelineChecks] = useState<Record<string, boolean>>({});
  const allGuidelinesChecked = CREATOR_GUIDELINES.every((g) => guidelineChecks[g.id]);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => () => {
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
  }, []);

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

    if (password !== confirmPassword) {
      refuse("Passwords do not match");
      return;
    }
    // The username is the one name nobody else may take, so it is required and
    // checked before the request goes out — the server checks it again, but a
    // round trip that fails on "too short" is a bad first impression.
    const handle = normalizeUsername(username);
    if (!handle) {
      refuse("Choose a username");
      return;
    }
    // Email only. Signing up with a phone number was removed along with the SMS
    // reset channel it depended on: the account it produced could not be
    // recovered. See registerSchema in lib/validation.ts.
    if (!email.trim()) {
      refuse(t("auth.emailRequired"));
      return;
    }
    if (role === "CREATOR" && !allGuidelinesChecked) {
      refuse("Soma na ukubali masharti yote ya creators kabla ya kujisajili");
      return;
    }

    setPhase("loading");
    setError("");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          username: handle,
          email: email.trim(),
          password,
          role,
          locale: "en",
          referralCode: referralCode || undefined,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // The acceptance is recorded server-side at registration — the account
        // is created with the current guidelines version — so there is nothing
        // to store in this browser.
        setPhase("success");
        toast(
          "success",
          role === "CREATOR"
            ? "Account created — let's verify you next."
            : `Karibu Genhub${displayName ? `, ${displayName}` : ""}!`
        );
        redirectTimer.current = setTimeout(() => {
          if (role === "CREATOR") router.push("/creator/kyc");
          else router.push("/");
          router.refresh();
        }, 900);
      } else {
        setPhase("idle");
        refuse(data.error || t("common.error"));
      }
    } catch {
      setPhase("idle");
      refuse(t("auth.networkError"));
    }
  }

  const busy = phase === "loading" || phase === "success";
  const strength = passwordStrength(password);
  const strengthStyle = STRENGTH[strength];

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl">
        <AuthBrandPanel
          eyebrow="Join Genhub"
          headline="Create your account and start watching in seconds."
          sub="Watch premium scenes, follow your favourite creators, and build a library that follows you to every device."
          points={[
            "Free to join — pay only for what you watch",
            "Creators keep uploading new scenes every day",
            "Your data stays private, your purchases stay yours",
          ]}
        />

        <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-md">
            <div className="mb-8 text-center lg:hidden">
              <div className="auth-float mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 glow-brand">
                <Play className="h-8 w-8 fill-white text-white" />
              </div>
            </div>
            <div className="auth-rise mb-8 text-center lg:text-left">
              <h1 className="font-display text-3xl font-bold">{t("auth.joinGenhub")}</h1>
              <p className={cn("mt-2 text-sm", isLight ? "text-gray-500" : "text-white/50")}>
                {t("auth.signUpDesc")}
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
              {phase === "success" && (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface-500/95 backdrop-blur">
                  <div className="auth-pop flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 ring-2 ring-emerald-400/60">
                    <Check className="h-8 w-8 text-emerald-400" />
                  </div>
                  <p className="font-display text-lg font-semibold">Account created ✓</p>
                  <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
                    {role === "CREATOR" ? "Taking you to verification…" : "Taking you in…"}
                  </p>
                </div>
              )}

              {error && (
                <div className="auth-rise flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">
                  <span className="mt-0.5">⚠</span>
                  <span>{error}</span>
                </div>
              )}

              {/* Role Selection */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setRole("VIEWER")}
                  className={cn(
                    "p-4 rounded-xl border text-center transition-all duration-300",
                    role === "VIEWER"
                      ? "border-brand-500 bg-brand-500/10 shadow-lg shadow-brand-500/10 scale-[1.02]"
                      : isLight ? "border-gray-200 hover:border-gray-300" : "border-white/10 hover:border-white/30"
                  )}
                >
                  <User className={cn("w-6 h-6 mx-auto mb-2 transition", role === "VIEWER" ? "text-brand-400" : isLight ? "text-gray-400" : "text-white/40")} />
                  <span className={cn("text-sm font-medium", role === "VIEWER" ? "text-brand-400" : isLight ? "text-gray-500" : "text-white/60")}>
                    {t("auth.viewer")}
                  </span>
                  <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>{t("auth.viewerDesc")}</p>
                </button>
                <button
                  type="button"
                  onClick={() => setRole("CREATOR")}
                  className={cn(
                    "p-4 rounded-xl border text-center transition-all duration-300",
                    role === "CREATOR"
                      ? "border-brand-500 bg-brand-500/10 shadow-lg shadow-brand-500/10 scale-[1.02]"
                      : isLight ? "border-gray-200 hover:border-gray-300" : "border-white/10 hover:border-white/30"
                  )}
                >
                  <Film className={cn("w-6 h-6 mx-auto mb-2 transition", role === "CREATOR" ? "text-brand-400" : isLight ? "text-gray-400" : "text-white/40")} />
                  <span className={cn("text-sm font-medium", role === "CREATOR" ? "text-brand-400" : isLight ? "text-gray-500" : "text-white/60")}>
                    {t("auth.creator")}
                  </span>
                  <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>{t("auth.creatorDesc")}</p>
                </button>
              </div>

              <div className="relative">
                <User className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    if (!usernameTouched) setUsername(usernameFromDisplayName(e.target.value));
                  }}
                  placeholder={t("auth.displayName")}
                  className="input-field pl-10"
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </div>

              <div>
                <div className="relative">
                  <AtSign className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => {
                      setUsernameTouched(true);
                      setUsername(e.target.value);
                    }}
                    placeholder="username"
                    className="input-field pl-10"
                    required
                    minLength={3}
                    maxLength={30}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <p className={cn("text-xs mt-1", isLight ? "text-gray-400" : "text-white/40")}>
                  Your public @handle, filled in from your name — change it to whatever you
                  like. {USERNAME_RULES_HINT}.
                </p>
              </div>

              <div className="relative">
                <Mail className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailRequired")} className="input-field pl-10" autoComplete="email" required />
              </div>

              <p className={cn("text-xs -mt-3", isLight ? "text-gray-400" : "text-white/40")}>
                {t("auth.emailWhy")}
              </p>

              <div className="relative">
                <Lock className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.passwordPlaceholder")}
                  className="input-field pl-10 pr-10"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} className={cn("absolute right-3 top-1/2 -translate-y-1/2 hover:text-gray-900", isLight ? "text-gray-400" : "text-white/40")}>
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Password strength — a nudge, not a gate */}
              {password && (
                <div className="auth-rise -mt-2 space-y-1">
                  <div className="flex gap-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 flex-1 rounded-full transition-all duration-300",
                          i < strength ? strengthStyle.color : isLight ? "bg-gray-200" : "bg-white/10"
                        )}
                      />
                    ))}
                  </div>
                  <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
                    Password strength: {strengthStyle.label || "—"}
                  </p>
                </div>
              )}

              <div className="relative">
                <Lock className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4", isLight ? "text-gray-400" : "text-white/40")} />
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder={t("auth.confirmPassword")} className="input-field pl-10" autoComplete="new-password" required />
              </div>

              {role === "CREATOR" && (
                <p className="text-xs text-amber-400/80 text-center">
                  {t("auth.kycWarning")}
                </p>
              )}

              {/* Creator guidelines — read and ticked as part of signing up, so
                  the conditions are known before any video is made. */}
              {role === "CREATOR" && (
                <div className="space-y-3 rounded-xl border border-white/10 p-4">
                  <div className="flex items-start gap-2">
                    <ScrollText className="mt-0.5 h-5 w-5 shrink-0 text-brand-400" />
                    <div>
                      <p className="text-sm font-medium">Masharti ya Creators</p>
                      <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/40")}>
                        Soma na ukubali kila sharti kabla ya kuanza kutengeneza video.
                      </p>
                    </div>
                  </div>

                  <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                    {CREATOR_GUIDELINES.map((g, i) => (
                      <label
                        key={g.id}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition",
                          guidelineChecks[g.id]
                            ? "border-emerald-500/40 bg-emerald-500/5"
                            : g.severe
                              ? "border-red-500/30 bg-red-500/5"
                              : isLight
                                ? "border-gray-200 hover:border-gray-300"
                                : "border-white/10 hover:border-white/20"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={!!guidelineChecks[g.id]}
                          onChange={(e) =>
                            setGuidelineChecks((prev) => ({ ...prev, [g.id]: e.target.checked }))
                          }
                          className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                        />
                        <div className="space-y-1">
                          <p className="flex items-center gap-2 text-sm font-medium">
                            <span className={isLight ? "text-gray-400" : "text-white/40"}>
                              {i + 1}.
                            </span>
                            {g.severe && <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />}
                            <span>{g.sw}</span>
                          </p>
                          <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/50")}>
                            {g.en}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>

                  <p className={cn("text-xs", isLight ? "text-gray-400" : "text-white/50")}>
                    {GUIDELINE_ACK_LABEL_SW}
                    <br />
                    {GUIDELINE_ACK_LABEL_EN}
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={busy || (role === "CREATOR" && !allGuidelinesChecked)}
                className={cn(
                  "btn-brand w-full inline-flex items-center justify-center gap-2",
                  phase === "loading" && "auth-busy"
                )}
              >
                {phase === "loading" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t("auth.creating")}
                  </>
                ) : phase === "success" ? (
                  <>
                    <Check className="w-4 h-4" />
                    {t("auth.createAccount")}
                  </>
                ) : (
                  <>
                    {t("auth.createAccount")}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

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
    </div>
  );
}
