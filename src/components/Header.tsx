"use client";

import { useState, useEffect, useRef } from "react";
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
  History,
  ArrowRight,
  Banknote,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import { useCurrency } from "@/lib/currency";
import Image from "next/image";
import NotificationBell from "@/components/NotificationBell";
import InboxUnreadBadge from "@/components/InboxUnreadBadge";
import VerifiedBadge from "@/components/VerifiedBadge";
import { useAllVideosFree } from "@/hooks/useSiteFlags";
import { usePurchasedVideoIds } from "@/hooks/usePurchasedVideos";
import { canOptimizeImage } from "@/lib/media";
import { displayHandle } from "@/lib/usernames";

interface UserData {
  id: string;
  /** Unique public handle; shown as @username when present. */
  username?: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: "VIEWER" | "CREATOR" | "ADMIN";
  walletBalance: number;
  /**
   * The creator's own withdrawable balance, from the same session answer as
   * everything else on this interface. It is null for a viewer or an admin, and
   * nothing but the signed-in account's row is ever returned by /api/auth/me —
   * so this number can only ever be the reader's own.
   */
  creatorBalance?: {
    pendingBalance: number;
    availableBalance: number;
    totalEarned: number;
  } | null;
}

interface SuggestVideo {
  id: string;
  title: string;
  slug: string | null;
  thumbnailUrl: string | null;
  price: number;
  /** Shown under the title so a row reads like a scene, not a bare filename. */
  creator?: { displayName: string | null; username?: string | null } | null;
}
interface SuggestCreator {
  id: string;
  username?: string | null;
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
  // A price in the search shelf must vanish while every video is free. See
  // hooks/useSiteFlags — the price shows only when the switch is known to be off.
  const allVideosFree = useAllVideosFree();
  // Scenes this viewer already owns show PAID in the shelf instead of a price
  // they have already paid — same rule as the cards, same shared read.
  const purchased = usePurchasedVideoIds();
  const [query, setQuery] = useState("");
  const [suggest, setSuggest] = useState<SuggestData | null>(null);
  const [showSuggest, setShowSuggest] = useState(false);
  // The whole header, so the hamburger inside the bar counts as "inside" the
  // menu it closes. See the dismissal effect below.
  const headerRef = useRef<HTMLElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

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

  /**
   * What the signed-in creator can withdraw right now, for the top bar.
   *
   * A creator's money was nowhere on the interface they land on: the top bar's
   * figure is the VIEWER wallet (what the account can spend), so a creator who
   * has earned TZS 2,450 and never topped up read "TZS 0" at the top of every
   * page while their dashboard said otherwise. Null for everybody else, so the
   * bar does not grow a number that means nothing to them.
   */
  const creatorAvailable =
    user?.role === "CREATOR" ? user.creatorBalance?.availableBalance ?? 0 : null;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // The shared answer is now wrong, and the Header is not the only reader.
    forgetCurrentUser();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  const isLight = theme === "light";

  /**
   * A menu must not outlive the gesture that opened it.
   *
   * Neither of these is a modal, so neither of them traps a press: a click
   * anywhere outside closes it, Escape closes it, and so does a navigation —
   * the account menu used to stay open across a route change and float over
   * whatever page the visitor had just landed on.
   *
   * The phone panel is measured against the WHOLE header rather than against
   * the panel itself, because the button that closes it lives in the bar above
   * the panel. Measuring the panel would make that button an "outside" press:
   * the handler closed the menu, the click then toggled it back open, and the
   * hamburger appeared to do nothing.
   */
  useEffect(() => {
    setMobileMenuOpen(false);
    setUserMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen && !userMenuOpen) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(target)) {
        setUserMenuOpen(false);
      }
      if (mobileMenuOpen && headerRef.current && !headerRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      setUserMenuOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileMenuOpen, userMenuOpen]);

  return (
    <header
      ref={headerRef}
      // `top` is not 0: the announcement banner (SiteBanner) is sticky above this
      // header and is taller than one line when its message wraps, so it
      // publishes its measured height as a CSS variable and the header parks
      // itself directly beneath it. With no banner the variable is 0px, which is
      // exactly the old `top-0`.
      style={{ top: "var(--site-banner-height, 0px)" }}
      className={cn(
        "sticky z-50 glass-chrome border-b safe-top",
        isLight ? "border-gray-200/70" : "border-white/5"
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group shrink-0 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center group-hover:scale-105 transition-transform glow-brand">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            {/* The wordmark is the first thing to give way on a very narrow
                phone. The mark alone still says Genhub, and dropping the text
                here is what keeps the row (and therefore the page) from
                overflowing to the right. */}
            <span className="text-xl font-display font-bold text-gradient hidden min-[380px]:inline">
              Genhub
            </span>
          </Link>

          {/* Desktop Search */}
          <div className="hidden md:flex flex-1 max-w-xl mx-8">
            <div className="relative w-full">
              <Search className={cn(
                "absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 z-10",
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
                className="input-field rounded-2xl py-3.5 pl-12 pr-4 text-base"
              />

              {/* Autocomplete dropdown. The old one was a list of bare titles
                  squeezed into the input's own width, which is why the results
                  read as unreadable. This is a proper results panel: wider than
                  the box, with a real thumbnail per scene, a title you can
                  actually read, the creator under it and the price on the
                  right — the way a media search shelf looks. */}
              {showSuggest && suggest && (
                <div className="glass-overlay absolute left-1/2 top-full z-50 mt-2 max-h-[70vh] w-[min(92vw,44rem)] -translate-x-1/2 overflow-y-auto p-3 animate-fade-in">
                  {suggest.videos.length > 0 && (
                    <div className="mb-2">
                      <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">Videos</p>
                      <div className="space-y-1">
                        {suggest.videos.map((v) => (
                          <button
                            key={v.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => goVideo(v)}
                            className="group flex w-full items-center gap-4 rounded-xl px-2 py-2 text-left transition hover:bg-white/10"
                          >
                            <span className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-white/10">
                              {v.thumbnailUrl ? (
                                <Image
                                  src={v.thumbnailUrl}
                                  alt=""
                                  fill
                                  sizes="112px"
                                  className="object-cover"
                                />
                              ) : (
                                <span className="flex h-full w-full items-center justify-center text-white/30">
                                  <Play className="h-5 w-5" />
                                </span>
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] font-semibold text-white group-hover:text-brand-300">
                                {v.title}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-white/50">
                                {v.creator
                                  ? displayHandle(v.creator, "Creator")
                                  : "Video"}
                              </span>
                            </span>
                            {allVideosFree !== true && purchased.has(v.id) ? (
                              <span className="shrink-0 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">
                                PAID
                              </span>
                            ) : allVideosFree === false && v.price > 0 ? (
                              <span className="shrink-0 rounded-full bg-brand-500/15 px-3 py-1 text-xs font-bold text-brand-300">
                                {format(v.price)}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {suggest.creators.length > 0 && (
                    <div className="mb-2">
                      <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">Creators</p>
                      <div className="space-y-1">
                        {suggest.creators.map((c) => (
                          <button
                            key={c.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => goCreator(c)}
                            className="group flex w-full items-center gap-4 rounded-xl px-2 py-2 text-left transition hover:bg-white/10"
                          >
                            <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-white/10">
                              {c.avatarUrl ? (
                                <Image
                                  src={c.avatarUrl}
                                  alt=""
                                  fill
                                  sizes="48px"
                                  className="object-cover"
                                />
                              ) : (
                                <span className="flex h-full w-full items-center justify-center text-sm font-bold text-white/60">
                                  {(c.username || c.displayName || "?").charAt(0).toUpperCase()}
                                </span>
                              )}
                            </span>
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="truncate text-[15px] font-semibold text-white group-hover:text-brand-300">
                                {displayHandle(c, "Creator")}
                              </span>
                              {c.isVerified && <VerifiedBadge className="h-4 w-4 shrink-0" />}
                            </span>
                            <span className="shrink-0 text-xs text-white/40">Creator</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {suggest.tags.length > 0 && (
                    <div className="mb-1">
                      <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">Tags</p>
                      <div className="flex flex-wrap gap-2 px-2 pb-2">
                        {suggest.tags.map((tag) => (
                          <button
                            key={tag}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => goTag(tag)}
                            className="rounded-full bg-brand-500/15 px-3 py-1.5 text-sm text-brand-300 transition hover:bg-brand-500/25"
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={submitSearch}
                    className="mt-1 flex w-full items-center justify-between border-t border-white/10 px-3 pt-3 pb-1 text-sm font-medium text-white/70 transition hover:text-white"
                  >
                    <span className="truncate">
                      See all results for “{query.trim()}”
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0" />
                  </button>
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
                <Link href="/inbox" className="btn-ghost relative flex items-center gap-2" title="Inbox">
                  <MessageSquare className="w-4 h-4" />
                  <span className="hidden lg:inline">Inbox</span>
                  {/* Corner-anchored so the count is visible in the narrow
                      layout too, where the label is hidden. */}
                  <InboxUnreadBadge className="absolute -right-0.5 -top-0.5" />
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
                {creatorAvailable !== null && (
                  <Link
                    href="/creator"
                    className="btn-ghost flex items-center gap-2"
                    title="Your withdrawable earnings — visible to you only"
                  >
                    <Banknote className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-medium">
                      {format(creatorAvailable)}
                    </span>
                  </Link>
                )}
                <Link href="/wallet" className="btn-ghost flex items-center gap-2" title="Wallet balance — what you can spend">
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
                <div className="relative" ref={userMenuRef}>
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
                        {(user.username?.[0] || user.displayName?.[0] || "U").toUpperCase()}
                      </div>
                    )}
                    <ChevronDown className="w-4 h-4 text-white/60" />
                  </button>

                  {userMenuOpen && (
                    // Nine rows plus a header: on a short window the list ran
                    // past the bottom of the screen with nowhere to go, because
                    // an absolutely-positioned panel has no ceiling of its own.
                    <div className="absolute right-0 top-full mt-2 w-56 glass-overlay p-2 animate-fade-in max-h-[70vh] overflow-y-auto overscroll-contain">
                      <div className="px-3 py-2 border-b border-white/10 mb-2">
                        <p className="font-medium text-sm">{displayHandle(user)}</p>
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
                        href="/history"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-white/10"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        <History className="w-4 h-4" /> Watch history
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
          {/*
            The phone row is deliberately thin: the two money chips and the
            menu button, and nothing else. Theme, currency and language used to
            sit here as well — three more controls on a row that already carried
            a wallet figure and an earnings figure once the user signed in. Six
            controls plus the logo is wider than a phone, so the row pushed the
            whole page sideways and every screen could be dragged left and
            right. They now live inside the menu they belong to (see the mobile
            panel below), and the chips truncate rather than grow.
          */}
          <div className="md:hidden flex items-center gap-1 min-w-0">
            {user && creatorAvailable !== null && (
              <Link
                href="/creator"
                className="flex items-center gap-1 px-1.5 py-1.5 rounded-xl hover:bg-white/10 min-w-0"
                title="Your withdrawable earnings — visible to you only"
              >
                <Banknote className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-[11px] font-semibold truncate max-w-[4.5rem]">
                  {format(creatorAvailable)}
                </span>
              </Link>
            )}
            {user && (
              <Link
                href="/wallet"
                className="flex items-center gap-1 px-1.5 py-1.5 rounded-xl hover:bg-white/10 min-w-0"
                title="Your wallet balance"
              >
                <Wallet className="w-4 h-4 text-brand-400 shrink-0" />
                <span className="text-[11px] font-semibold truncate max-w-[4.5rem]">
                  {format(user.walletBalance)}
                </span>
              </Link>
            )}
            {/* The bell, on the phone.

                It lived only in the desktop nav (`hidden md:flex`), so on a
                handset — which is where most of this platform is read — there
                was NO notification surface at all: an admin could reject a
                withdrawal with a reason written out in words and the creator
                had nothing to open. It sits here, beside the menu button, so
                the badge is visible on every page without opening anything. */}
            {user && <NotificationBell />}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-xl hover:bg-white/10 shrink-0"
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className={cn(
          // `menu-scroll` gives the panel the height the viewport has left and
          // makes it its own scroll container — see globals.css. Without it the
          // panel was as tall as its list, the sticky header could not be
          // scrolled to reach the rows at the bottom, and the only thing a thumb
          // could move was the page underneath.
          "menu-scroll md:hidden glass-chrome border-t animate-slide-down",
          isLight ? "border-gray-200/70" : "border-white/5"
        )}>
          <div className="px-4 py-4 space-y-2">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/40" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch();
                }}
                placeholder={t("nav.search")}
                className="input-field rounded-2xl py-3.5 pl-12 pr-4 text-base"
              />
            </div>

            {/* The appearance / currency / language controls, moved off the
                top row so it fits any phone. They are the same three buttons,
                now with labels, in the panel that opens from the menu icon. */}
            <div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-white/10 hover:bg-white/10 text-sm"
              >
                {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                {isLight ? "Dark" : "Light"}
              </button>
              <button
                onClick={toggleCurrency}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 hover:bg-white/10 text-sm"
                title="Switch currency"
              >
                <DollarSign className="w-4 h-4" />
                <span className="font-bold">{currency}</span>
              </button>
              <button
                onClick={() => setLocale(locale === "en" ? "sw" : "en")}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 hover:bg-white/10 text-sm"
                title="Switch language"
              >
                <Globe className="w-4 h-4" />
                <span className="font-bold uppercase">{locale}</span>
              </button>
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
                      {(user.username?.[0] || user.displayName?.[0] || "U").toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-sm">{displayHandle(user)}</p>
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
                  <InboxUnreadBadge className="ml-auto" />
                </Link>
                <Link href="/notifications" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <Bell className="w-5 h-5" /> {t("nav.notifications")}
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
                <Link href="/history" className="btn-ghost w-full flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
                  <History className="w-5 h-5" /> Watch history
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
