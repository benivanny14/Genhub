"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import { Play, Lock, Eye, EyeOff, CheckCircle } from "lucide-react";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  if (!token) {
    return (
      <div className="text-center">
        <h2 className="text-xl font-bold mb-2">Invalid Token</h2>
        <p className="text-white/50 text-sm">The password reset link is invalid</p>
        <Link href="/forgot-password" className="btn-brand mt-4 inline-block">
          Request Again
        </Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (data.success) setSuccess(true);
      else setError(data.error || "Error");
    } catch { setError("Network error"); }
    finally { setLoading(false); }
  }

  if (success) {
    return (
      <div className="glass-card p-8 text-center">
        <CheckCircle className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
        <h2 className="text-lg font-bold mb-2">Password Changed!</h2>
        <p className="text-sm text-white/60 mb-6">You can now sign in with your new password.</p>
        <Link href="/login" className="btn-brand">Sign In Now</Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
      {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-xl">{error}</div>}
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
        <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (8+ characters)" className="input-field pl-10 pr-10" required minLength={8} />
        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white">
          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password" className="input-field pl-10" required />
      </div>
      <button type="submit" disabled={loading} className="btn-brand w-full">{loading ? "Saving..." : "Set New Password"}</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mb-4 glow-brand">
              <Play className="w-8 h-8 text-white fill-white" />
            </div>
            <h1 className="text-2xl font-display font-bold">Set New Password</h1>
          </div>
          <Suspense fallback={<div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" /></div>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
