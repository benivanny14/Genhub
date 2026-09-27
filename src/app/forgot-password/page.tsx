"use client";

import { useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import { Play, Mail, ArrowLeft, CheckCircle } from "lucide-react";

// Email only, and the screen says so. It used to offer an Email/Phone toggle
// and promise "a recovery code" on either, which matched the API while the API
// still had an SMS branch — and kept promising it after that branch could no
// longer deliver. A recovery screen that offers a channel the platform cannot
// use is how somebody ends up waiting for a text that is never coming.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      // The server answers the same way whether or not the address is
      // registered, so the screen must not invent a difference either.
      if (res.ok) {
        setSent(true);
        return;
      }

      const data = await res.json().catch(() => null);
      setError(data?.error || "Could not send the reset link. Please try again.");
    } catch {
      setError("Network error. Please check your connection and try again.");
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
            <h1 className="text-2xl font-display font-bold">Forgot Password?</h1>
            <p className="text-white/50 text-sm mt-2">
              We&apos;ll email you a link to choose a new password
            </p>
          </div>

          {sent ? (
            <div className="glass-card p-8 text-center">
              <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
              <h2 className="text-lg font-bold mb-2">Check your email</h2>
              <p className="text-sm text-white/60 mb-3">
                If an account exists for <span className="text-white/80">{email}</span>, we
                sent it a reset link. It stays valid for one hour.
              </p>
              <p className="text-xs text-white/40 mb-6">
                Nothing in your inbox? Look in spam, and make sure you used the address you
                signed up with. If you used a different one, a link is still only ever sent
                to the address on the account.
              </p>
              <Link href="/login" className="btn-brand">
                Back to Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@example.com"
                  className="input-field pl-10"
                  autoComplete="email"
                  required
                />
              </div>

              {error && (
                <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                  {error}
                </p>
              )}

              <p className="text-xs text-white/40">
                Reset links are sent by email only. There is no code by text message, so
                there is nothing to wait for on your phone.
              </p>

              <button type="submit" disabled={loading} className="btn-brand w-full">
                {loading ? "Sending..." : "Email me a reset link"}
              </button>

              <Link
                href="/login"
                className="flex items-center justify-center gap-2 text-sm text-white/50 hover:text-white transition"
              >
                <ArrowLeft className="w-4 h-4" /> Back to Sign In
              </Link>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
