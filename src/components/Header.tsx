"use client";

import { useState, useEffect } from "react";
import { fetchCurrentUser, forgetCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  X,
  Search,
  Bell,
  Wallet,
  Upload,
  Shield,
  LogOut,
  User,
  ChevronDown,
  Play,
  Heart,
  Sun,
  Moon,
  Globe,
  Users,
  MessageSquare,
  DollarSign,
  Flame,
  ListVideo,
  CreditCard,
  ReceiptText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { useCurrency } from "@/lib/currency";
import Image from "next/image";
import NotificationBell from "@/components/NotificationBell";
import { canOptimizeImage } from "@/lib/media";

interface UserData {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: "VIEWER" | "CREATOR" | "ADMIN";
  walletBalance: number;
}

interface SuggestVideo {
  id: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
}
interface SuggestCreator {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
}
interface SuggestData {
  videos: SuggestVideo[];
  creators: SuggestCreator[];
  tags: string[];
}

export default function Header() {
  const [user, setUser] = useState<UserData | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();
  const { currency, toggleCurrency, format } = useCurrency();
  const [query, setQuery] = useState("");
  const [suggest, setSuggest] = useState<SuggestData | null>(null);
  const [showSuggest, setShowSuggest] = useState(false);

  // Debounced search autocomplete
  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggest(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        if (data.success) {
          setSuggest(data.data);
          setShowSuggest(true);
        }
      } catch {}
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // The header used to push `/?q=…`; the home page filters its feed for that
  // parameter, so a search did work — but it rendered as the front page with a
  // filter, with no result count, no matched creators, and the top five
  // suggestions left as the only place most matches were ever visible.
  // /search is a page whose whole job is answering the query.
  function submitSearch() {
    const q = query.trim();
    if (!q) return;
    setShowSuggest(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  function goVideo(v: SuggestVideo) {
    setShowSuggest(false);
    setQuery("");
    router.push(`/video/${v.slug || v.id}`);
  }

  function goCreator(c: SuggestCreator) {
    setShowSuggest(false);
    setQuery("");
    router.push(`/creator/${c.id}`);
  }

  function goTag(tag: string) {
    setShowSuggest(false);
    setQuery(tag);
    router.push(`/search?q=${encodeURIComponent(tag)}`);
  }

  useEffect(() => {
    fetchUser();
  }, []);

  async function fetchUser() {
    try {
      const res = await fetchCurrentUser();
      const data = await res.json();
      if (data.success) {
        setUser(data.data);
      }
    } catch {
      // Not logged in
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // The shared answer is now wrong, and the Header is not the only reader.
    forgetCurrentUser();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  const isLight = theme === "light";

  return (
    <header className={cn(
      "sticky top-0 z-50 backdrop-blur-xl border-b safe-top transition-colors duration-300",
      isLight
        ? "bg-white/80 border-gray-200/50"
        : "bg-surface-500/80 border-white/5"
    )}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center group-hover:scale-105 transition-transform glow-brand">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="text-xl font-display font-bold text-gradient">
              Genhub
            </span>
          </Link>

          {/* Desktop Search */}
          <div className="hidden md:flex flex-1 max-w-md mx-8">
            <div className="relative w-full">
              <Search className={cn(
                "absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 z-10",
                isLight ? "text-gray-400" : "text-white/40"
              )} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => suggest && setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 200)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                }}
                placeholder={t("nav.search")}
                className={cn("input-field pl-10 py-2 text-sm")}
              />

              {/* Autocomplete dropdown */}
              {showSuggest && suggest && (
                <div className="absolute top-full left-0 right-0 mt-1 glass-card p-2 z-50 animate-fade-in max-h-96 overflow-y-auto">
                  {suggest.videos.length > 0 && (
                    <div className="mb-1">
                      <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">Videos</p>
                      {suggest.videos.map((v) => (
                        <button
                          key={v.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => goVideo(v)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm hover:bg-white/10 text-left"
                        >
                          <Play className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                          <span className="truncate flex-1">{v.title}</span>
                          {v.price > 0 && (
                            <span className="text-[10px] text-white/40 shrink-0">
                              {format(v.price)}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {suggest.creators.length > 0 && (
                    <div className="mb-1">
                      <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">Creators</p>
                      {suggest.creators.map((c) => (
                        <button
                          key={c.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => goCreator(c)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm hover:bg-white/10 text-left"
                        >
                          <User className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                          <span className="truncate flex-1">{c.displayName || "Creator"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {suggest.tags.length > 0 && (
                    <div>
                      <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">Tags</p>
                      <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                        {suggest.tags.map((tag) => (
                          <button
                            key={tag}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => goTag(tag)}
                            className="bg-brand-500/15 text-brand-400 px-2 py-0.5 rounded-full text-xs hover:bg-brand-500/25"
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {suggest.videos.length === 0 && suggest.creators.length === 0 && suggest.tags.length === 0 && (
                    <p className="px-3 py-2 text-sm text-white/40">No matches</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-2">
            {user ? (
              <>
                {user.role === "CREATOR" && (
                  <Link href="/creator/upload" className="btn-ghost flex items-center gap-2">
                    <Upload className="w-4 h-4" />
                    <span className="hidden lg:inline">{t("nav.upload")}</span>
                  </Link>
                )}
                <Link href="/feed" className="btn-ghost flex items-center gap-2" title="Following feed">
                  <Users className="w-4 h-4" />
                  <span className="hidden lg:inline">Feed</span>
                </Link>
                <Link href="/trending" className="btn-ghost flex items-center gap-2" title="Trending now">
                  <Flame className="w-4 h-4" />
                  <span className="hidden lg:inline">Trending</span>
                </Link>
                <Link href="/inbox" className="btn-ghost flex items-center gap-2" title="Inbox">
                  <MessageSquare className="w-4 h-4" />
                  <span className="hidden lg:inline">Inbox</span>
                </Link>
                <Link href="/favorites" className="btn-ghost flex items-center gap-2" title="Saved videos">
                  <Heart className="w-4 h-4" />
                </Link>
                <Link href="/playlists" className="btn-ghost flex items-center gap-2" title="Playlists">
                  <ListVideo className="w-4 h-4" />
                </Link>
                <Link href="/payments" className="btn-ghost flex items-center gap-2" title="My payments">
                  <ReceiptText className="w-4 h-4" />
                </Link>
                <Link href="/wallet" className="btn-ghost flex items-center gap-2">
                  <Wallet className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    {format(user.walletBalance)}
                  </span>
                </Link>

                {/* Currency Toggle */}
                <button
                  onClick={toggleCurrency}
                  className="btn-ghost p-2 flex items-center gap-1"
                  title="Switch currency (TZS / USD)"
                >
                  <DollarSign className="w-4 h-4" />
                  <span className="text-xs font-bold">{currency}</span>
                </button>

                {/* Theme Toggle */}
                <button onClick={toggleTheme} className="btn-ghost p-2" title="Toggle theme">
                  {isLight ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                </button>

                {/* Language Toggle */}
                <button
                  onClick={() => setLocale(locale === "en" ? "sw" : "en")}
                  className="btn-ghost p-2 flex items-center gap-1"
                  title="Switch language"
                >
                  <Globe className="w-5 h-5" />
                  <span className="text-xs font-bold uppercase">{locale}</span>
                </button>

                <NotificationBell />

                {/* User Dropdown */}
                <div className="relative">
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-white/10 transition"
                  >
                    {/* The picture the user uploaded, not just an initial — the
                        letter is the fallback for anyone who has not set one. */}
                    {user.avatarUrl ? (
                      // An uploaded avatar is a 512×512 file shown at 32px, so it
                      // only costs what it should when it goes through the
                      // optimiser. An external URL cannot (see canOptimizeImage)
                      // and falls back to the raw source.
                      <Image
                        src={user.avatarUrl}
                        alt=""
                        width={32}
                        height={32}
                        unoptimized={!canOptimizeImage(user.avatarUrl)}
                        className="w-8 h-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-medium text-sm">
                        {user.displayName?.[0] || "U"}
                      </div>
                    )}
                    <ChevronDown className="w-4 h-4 text-white/60" />
                  </button>

                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-56 glass-card p-2 animate-fade-in">
                      <div className="px-3 py-2 border-b border-white/10 mb-2">
                        <p className="font-medium text-sm">{user.displayName}</p>
                        <p className="text-xs text-white/50">{user.email || user.phone}</p>
                      </div>
                      <Link
                        href="/profile"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <User className="w-4 h-4" /> {t("nav.myProfile")}
                      </Link>
                      {user.role === "CREATOR" && (
                        <Link
                          href="/creator"
                          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                          onClick={() => setUserMenuOpen(false)}
                        >
                          <Upload className="w-4 h-4" /> {t("nav.dashboard")}
                        </Link>
                      )}
                      {user.role === "ADMIN" && (
                        <Link
                          href="/admin"
                          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                          onClick={() => setUserMenuOpen(false)}
                        >
                          <Shield className="w-4 h-4" /> {t("nav.admin")}
                        </Link>
                      )}
                      <Link
                        href="/playlists"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <ListVideo className="w-4 h-4" /> My Playlists
                      </Link>
                      <Link
                        href="/billing"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <CreditCard className="w-4 h-4" /> Billing
                      </Link>
                      <Link
                        href="/payments"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <ReceiptText className="w-4 h-4" /> My Payments
                      </Link>
                      <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 mt-1"
                      >
                        <LogOut className="w-4 h-4" /> {t("nav.signOut")}
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <button onClick={toggleTheme} className="btn-ghost p-2">
                  {isLight ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                </button>
                <button
                  onClick={toggleCurrency}
                  className="btn-ghost p-2 flex items-center gap-1"
                  title="Switch currency"
                >
                  <DollarSign className="w-4 h-4" />
                  <span className="text-xs font-bold">{currency}</span>
                </button>
                <button
                  onClick={() => setLocale(locale === "en" ? "sw" : "en")}
                  className="btn-ghost p-2 flex items-center gap-1"
                >
                  <Globe className="w-5 h-5" />
                  <span className="text-xs font-bold uppercase">{locale}</span>
                </button>
                <Link href="/login" className="btn-ghost">
                  {t("nav.signIn")}
                </Link>
                <Link href="/register" className="btn-brand text-sm py-2 px-4">
                  {t("nav.getStarted")}
                </Link>
              </div>
            )}
          </nav>

          {/* Mobile Menu Toggle */}
          <div className="md:hidden flex items-center gap-1">
            <button onClick={toggleTheme} className="p-2 rounded-xl hover:bg-white/10">
              {isLight ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
            </button>
            <button
              onClick={toggleCurrency}
              className="p-2 rounded-xl hover:bg-white/10 flex items-center gap-0.5"
              title="Switch currency"
            >
              <DollarSign className="w-4 h-4" />
              <span className="text-[10px] font-bold">{currency}</span>
            </button>
            <button
              onClick={() => setLocale(locale === "en" ? "sw" : "en")}
              className="p-2 rounded-xl hover:bg-white/10"
            >
              <Globe className="w-5 h-5" />
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-xl hover:bg-white/10"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className={cn(
          "md:hidden border-t backdrop-blur-xl animate-slide-down transition-colors",
          isLight ? "border-gray-200 bg-white/95" : "border-white/5 bg-surface-500/95"
        )}>
          <div className="px-4 py-4 space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                }}
                placeholder={t("nav.search")}
                className="input-field pl-10 py-2.5 text-sm"
              />
            </div>

            {user ? (
              <>
                <div className="flex items-center gap-3 px-3 py-3 glass-card">
                  {user.avatarUrl ? (
                    <Image
                      src={user.avatarUrl}
                      alt=""
                      width={40}
                      height={40}
                      unoptimized={!canOptimizeImage(user.avatarUrl)}
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-medium">
                      {user.displayName?.[0] || "U"}
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-sm">{user.displayName}</p>
                    <p className="text-xs text-white/50">
                      {format(user.walletBalance)}
                    </p>
                  </div>
                </div>
                <Link href="/favorites" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <Heart className="w-5 h-5" /> {t("nav.favorites")}
                </Link>
                <Link href="/feed" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <Users className="w-5 h-5" /> Feed
                </Link>
                <Link href="/inbox" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <MessageSquare className="w-5 h-5" /> Inbox
                </Link>
                <Link href="/wallet" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <Wallet className="w-5 h-5" /> {t("nav.wallet")}
                </Link>
                <Link href="/trending" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <Flame className="w-5 h-5" /> Trending
                </Link>
                <Link href="/playlists" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <ListVideo className="w-5 h-5" /> My Playlists
                </Link>
                <Link href="/billing" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <CreditCard className="w-5 h-5" /> Billing
                </Link>
                <Link href="/payments" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <ReceiptText className="w-5 h-5" /> My Payments
                </Link>
                {user.role === "CREATOR" && (
                  <Link href="/creator" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                    <Upload className="w-5 h-5" /> {t("nav.dashboard")}
                  </Link>
                )}
                {user.role === "ADMIN" && (
                  <Link href="/admin" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                    <Shield className="w-5 h-5" /> {t("nav.admin")}
                  </Link>
                )}
                <button onClick={handleLogout} className="btn-ghost w-full flex items-center gap-3 text-red-400">
                  <LogOut className="w-5 h-5" /> {t("nav.signOut")}
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-2 pt-2">
                <Link href="/login" className="btn-ghost w-full text-center" onClick={() => setMobileMenuOpen(false)}>
                  {t("nav.signIn")}
                </Link>
                <Link href="/register" className="btn-brand w-full text-center" onClick={() => setMobileMenuOpen(false)}>
                  {t("nav.getStarted")}
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
