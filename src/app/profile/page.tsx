"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { User, Mail, Phone, Lock, Globe, Save, Shield, Users, Copy, Gift } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

interface UserData {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  locale: string;
  walletBalance: number;
  kycStatus: string;
}

interface ReferralRow {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
  bonus: number;
}

interface ReferralData {
  code: string | null;
  link: string | null;
  referredCount: number;
  referralEarnings: number;
  rewardPerReferral: number;
  referrals?: ReferralRow[];
}

export default function ProfilePage() {
  const router = useRouter();
  const { toast } = useToast();
  const { theme } = useTheme();
  const isLight = theme === "light";
  const [user, setUser] = useState<UserData | null>(null);
  const [referral, setReferral] = useState<ReferralData | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [locale, setLocale] = useState("en");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNew, setConfirmNew] = useState("");

  const fetchReferral = useCallback(async () => {
    try {
      const res = await fetch("/api/referral");
      const data = await res.json();
      if (data.success) setReferral(data.data);
    } catch {}
  }, []);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetchCurrentUser();
      const data = await res.json();
      if (data.success) {
        setUser(data.data);
        setDisplayName(data.data.displayName || "");
        setEmail(data.data.email || "");
        setPhone(data.data.phone || "");
        setLocale(data.data.locale || "en");
      } else {
        router.push("/login");
      }
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  async function copyReferralLink() {
    if (!referral?.link) return;
    try {
      await navigator.clipboard.writeText(referral.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  useEffect(() => {
    fetchUser();
    fetchReferral();
  }, [fetchUser, fetchReferral]);

  async function handleProfileUpdate() {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, locale }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Profile updated!");
        fetchUser();
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "An error occurred");
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordChange() {
    if (newPassword !== confirmNew) {
      toast("error", "Passwords do not match");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Password changed!");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmNew("");
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <h1 className={cn("text-2xl font-display font-bold", isLight && "text-gray-900")}>My Profile</h1>

        {/* Profile Info */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="font-display font-bold flex items-center gap-2">
            <User className="w-5 h-5 text-brand-400" /> Personal Information
          </h2>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Display Name</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input-field pl-10"
              />
            </div>
          </div>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="email"
                value={email}
                readOnly
                className="input-field pl-10 opacity-60 cursor-not-allowed"
              />
            </div>
          </div>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Phone Number</label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="tel"
                value={phone}
                readOnly
                className="input-field pl-10 opacity-60 cursor-not-allowed"
              />
            </div>
          </div>

          <div>
            <label className={cn("text-sm mb-1 block flex items-center gap-2", isLight ? "text-gray-500" : "text-white/60")}>
              <Globe className="w-4 h-4" /> Language
            </label>
            <select value={locale} onChange={(e) => setLocale(e.target.value)} className="input-field">
              <option value="en">English</option>
              <option value="sw">Kiswahili</option>
            </select>
          </div>

          <button onClick={handleProfileUpdate} disabled={saving} className="btn-brand flex items-center gap-2">
            <Save className="w-4 h-4" />
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>

        {/* Password Change */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="font-display font-bold flex items-center gap-2">
            <Lock className="w-5 h-5 text-brand-400" /> Change Password
          </h2>

          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input-field"
              minLength={8}
            />
          </div>
          <div>
            <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>Confirm New Password</label>
            <input
              type="password"
              value={confirmNew}
              onChange={(e) => setConfirmNew(e.target.value)}
              className="input-field"
            />
          </div>

          <button
            onClick={handlePasswordChange}
            disabled={saving || !currentPassword || !newPassword}
            className="btn-brand"
          >
            Change Password
          </button>
        </div>

        {/* Referral / Affiliate program */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="font-display font-bold flex items-center gap-2">
            <Gift className="w-5 h-5 text-amber-400" /> Invite Friends — Earn TZS 1,000
          </h2>
          <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
            Share your code. When a friend creates an account, you both earn a wallet bonus.
          </p>

          {referral?.code ? (
            <>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 input-field flex items-center font-mono tracking-wider uppercase">
                  {referral.link}
                </div>
                <button onClick={copyReferralLink} className="btn-brand flex items-center gap-2 justify-center">
                  <Copy className="w-4 h-4" /> {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface-300/40 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold">{referral.referredCount}</p>
                  <p className="text-xs text-white/50 flex items-center justify-center gap-1">
                    <Users className="w-3 h-3" /> Friends joined
                  </p>
                </div>
                <div className="bg-surface-300/40 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-emerald-400">
                    TZS {referral.referralEarnings.toLocaleString()}
                  </p>
                  <p className="text-xs text-white/50">Referral earnings</p>
                </div>
              </div>

              {/* Conversion history */}
              {referral.referrals && referral.referrals.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-white/50 uppercase tracking-wide">
                    Recent invites
                  </p>
                  <ul className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                    {referral.referrals.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between text-sm bg-surface-300/30 rounded-lg px-3 py-2"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="w-6 h-6 rounded-full bg-brand-500/20 text-brand-300 flex items-center justify-center text-xs font-bold shrink-0">
                            {(r.displayName || "U")[0].toUpperCase()}
                          </span>
                          <span className="truncate">{r.displayName || "New user"}</span>
                        </span>
                        <span className="text-right shrink-0 pl-3">
                          <span className="text-emerald-400 text-xs font-medium block">
                            + TZS {r.bonus.toLocaleString()}
                          </span>
                          <span className="text-[10px] text-white/40">
                            {new Date(r.joinedAt).toLocaleDateString()}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="skeleton h-16 w-full" />
          )}
        </div>

        {/* Quick Links */}
        <div className="glass-card p-4 space-y-2">
          <Link href="/wallet" className="btn-ghost w-full flex items-center gap-2 text-left">
            💰 Wallet — Balance: TZS {user?.walletBalance?.toLocaleString() || 0}
          </Link>
          {user?.role === "CREATOR" && (
            <Link href="/creator" className="btn-ghost w-full flex items-center gap-2 text-left">
              📊 Creator Dashboard
            </Link>
          )}
          {user?.kycStatus !== "APPROVED" && user?.role === "CREATOR" && (
            <Link href="/creator/kyc" className="btn-ghost w-full flex items-center gap-2 text-left text-amber-400">
              <Shield className="w-4 h-4" /> Complete KYC
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
