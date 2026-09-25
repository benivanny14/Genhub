"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser, forgetCurrentUser } from "@/lib/current-user";
import Header from "@/components/Header";
import Image from "next/image";
import ImageCropper from "@/components/ImageCropper";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  User,
  Mail,
  Phone,
  Lock,
  Globe,
  Save,
  Shield,
  Users,
  Copy,
  Gift,
  Camera,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { canOptimizeImage } from "@/lib/media";
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
  avatarUrl: string | null;
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

  // Profile picture — the same upload path as every other image, so a broken
  // avatar cannot be a different bug from a broken thumbnail.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // The file waiting to be framed. Nothing is uploaded until the picture has
  // been moved and zoomed to the way the owner wants it to look.
  const [cropFile, setCropFile] = useState<File | null>(null);

  // Delete-account state. Two separate values on purpose: the password proves it
  // is the account holder, the typed word proves it is not an accident.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
        setAvatarUrl(data.data.avatarUrl || null);
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

  /**
   * Save a new profile picture.
   *
   * Two calls, in order: upload the file, then attach its URL. The second is
   * what makes it real, so a failure there is reported rather than swallowed —
   * otherwise the page would show the new picture until the next reload and
   * then silently revert.
   */
  async function handleAvatarChange(file: File) {
    setUploadingAvatar(true);
    try {
      const { uploadImage, UploadError } = await import("@/lib/upload-client");
      const url = await uploadImage(file, { kind: "public" });
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: url }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "The picture could not be saved");
        return;
      }
      setAvatarUrl(url);
      forgetCurrentUser();
      toast("success", "Profile picture updated");
    } catch (error) {
      toast(
        "error",
        error instanceof Error && error.name === "UploadError"
          ? error.message
          : "The picture could not be uploaded"
      );
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleAvatarRemove() {
    setUploadingAvatar(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: null }),
      });
      const data = await res.json();
      if (!data.success) {
        toast("error", data.error || "The picture could not be removed");
        return;
      }
      setAvatarUrl(null);
      forgetCurrentUser();
      toast("success", "Profile picture removed");
    } catch {
      toast("error", "Network error");
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleteError(null);
    if (deleteConfirm.trim().toUpperCase() !== "DELETE") {
      setDeleteError("Type DELETE to confirm");
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword, confirm: deleteConfirm }),
      });
      const data = await res.json();
      if (!data.success) {
        // 401 here means the password was wrong — say that, not "an error".
        setDeleteError(
          data.code === "BAD_PASSWORD"
            ? "That password is not correct"
            : data.error || "The account could not be deleted"
        );
        return;
      }
      // The cookie is gone with the account, so this is a fresh visitor now.
      forgetCurrentUser();
      toast("success", "Your account has been deleted");
      router.push("/");
    } catch {
      setDeleteError("Network error — nothing was deleted");
    } finally {
      setDeleting(false);
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

      {/* Move and zoom the new picture, then upload the framing the owner chose. */}
      {cropFile && (
        <ImageCropper
          file={cropFile}
          confirmLabel="Save picture"
          busy={uploadingAvatar}
          onCancel={() => setCropFile(null)}
          onConfirm={(cropped) => {
            setCropFile(null);
            void handleAvatarChange(cropped);
          }}
        />
      )}

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <h1 className={cn("text-2xl font-display font-bold", isLight && "text-gray-900")}>My Profile</h1>

        {/* Profile Info */}
        <div className="glass-card p-6 space-y-4">
          <h2 className="font-display font-bold flex items-center gap-2">
            <User className="w-5 h-5 text-brand-400" /> Personal Information
          </h2>

          {/* Profile picture */}
          <div className="flex items-center gap-4">
            <div className="relative w-20 h-20 shrink-0 rounded-full overflow-hidden bg-surface-300/50 flex items-center justify-center">
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt="Your profile picture"
                  width={80}
                  height={80}
                  unoptimized={!canOptimizeImage(avatarUrl)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className={cn("text-2xl font-bold", isLight ? "text-gray-400" : "text-white/40")}>
                  {(displayName || user?.phone || "U")[0]?.toUpperCase()}
                </span>
              )}
              {uploadingAvatar && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className={cn("text-sm font-medium", isLight ? "text-gray-700" : "text-white/80")}>
                Profile picture
              </p>
              <p className={cn("text-xs", isLight ? "text-gray-500" : "text-white/40")}>
                Shown next to your name on your profile, in the feed and on your videos.
                JPEG, PNG or WebP, up to 5 MB. You can move and zoom the picture
                before it is saved.
              </p>
              <div className="flex items-center gap-2">
                <label
                  className={cn(
                    "btn-ghost text-xs flex items-center gap-1.5 cursor-pointer",
                    uploadingAvatar && "opacity-50 pointer-events-none"
                  )}
                >
                  <Camera className="w-3.5 h-3.5" />
                  {avatarUrl ? "Change picture" : "Upload picture"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // Reset the input so picking the same file again still fires.
                      e.target.value = "";
                      if (!file) return;
                      if (!file.type.startsWith("image/")) {
                        toast("error", "Please choose an image file");
                        return;
                      }
                      // Frame it first — this is the whole point of the step.
                      setCropFile(file);
                    }}
                  />
                </label>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => void handleAvatarRemove()}
                    disabled={uploadingAvatar}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

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

        {/* Danger zone */}
        <div className="glass-card p-6 space-y-3 border border-red-500/30">
          <h2 className="font-display font-bold flex items-center gap-2 text-red-400">
            <TriangleAlert className="w-5 h-5" /> Delete account
          </h2>
          <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
            Deleting your account removes it and its contents for good: your videos
            disappear from the site and from the video host, your identity documents
            are destroyed, and your messages and purchase history go with it. Nothing
            here can be undone, and a new account will not bring any of it back.
          </p>

          {!deleteOpen ? (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="rounded-xl border border-red-500/40 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/10 transition"
            >
              Delete my account
            </button>
          ) : (
            <div className="space-y-3 rounded-xl bg-red-500/5 border border-red-500/20 p-4">
              <div>
                <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>
                  Your password
                </label>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  autoComplete="current-password"
                  className="input-field"
                />
              </div>
              <div>
                <label className={cn("text-sm mb-1 block", isLight ? "text-gray-500" : "text-white/60")}>
                  Type DELETE to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder="DELETE"
                  className="input-field font-mono tracking-widest"
                />
              </div>

              {deleteError && <p className="text-sm text-red-400">{deleteError}</p>}

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeletePassword("");
                    setDeleteConfirm("");
                    setDeleteError(null);
                  }}
                  disabled={deleting}
                  className="btn-ghost flex-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteAccount()}
                  disabled={deleting || !deletePassword || deleteConfirm.trim().toUpperCase() !== "DELETE"}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Delete permanently
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
