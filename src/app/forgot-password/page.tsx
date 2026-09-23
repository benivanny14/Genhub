"use client";

import { useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import { Play, Mail, Phone, ArrowLeft, CheckCircle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [loginType, setLoginType] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginType === "email" ? { email } : { phone }),
      });

      if (res.ok) {
        setSent(true);
      }
    } catch {
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
              We&apos;ll send you a recovery code
            </p>
          </div>

          {sent ? (
            <div className="glass-card p-8 text-center">
              <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
              <h2 className="text-lg font-bold mb-2">Message Sent!</h2>
              <p className="text-sm text-white/60 mb-6">
                Please check your phone or email for the recovery code.
              </p>
              <Link href="/login" className="btn-brand">
                Back to Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
              <div className="flex bg-surface-300/40 rounded-xl p-1">
                <button
                  type="button"
                  onClick={() => setLoginType("email")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                    loginType === "email" ? "bg-brand-500 text-white" : "text-white/60"
                  }`}
                >
                  Email
                </button>
                <button
                  type="button"
                  onClick={() => setLoginType("phone")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                    loginType === "phone" ? "bg-brand-500 text-white" : "text-white/60"
                  }`}
                >
                  Phone
                </button>
              </div>

              {loginType === "email" ? (
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="input-field pl-10"
                    required
                  />
                </div>
              ) : (
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="07XX XXX XXX"
                    className="input-field pl-10"
                    required
                  />
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-brand w-full">
                {loading ? "Sending..." : "Send Recovery Code"}
              </button>

              <Link href="/login" className="flex items-center justify-center gap-2 text-sm text-white/50 hover:text-white transition">
                <ArrowLeft className="w-4 h-4" /> Back to Sign In
              </Link>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
