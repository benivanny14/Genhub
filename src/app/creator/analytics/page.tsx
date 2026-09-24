"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import {
  BarChart3,
  Eye,
  Banknote,
  Wallet,
  Users,
  TrendingUp,
  ArrowLeft,
  DollarSign,
  ArrowUpRight,
  Crown,
} from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { formatTZS, formatCount, cn } from "@/lib/utils";

interface AnalyticsData {
  totals: {
    publishedVideos: number;
    totalViews: number;
    totalLikes: number;
    totalPurchases: number;
    pendingBalance: number;
    availableBalance: number;
    lifetimeEarned: number;
    subscribers: number;
    revenue30d: number;
    pendingPayouts: number;
    conversionRate: number;
  };
  daily: { date: string; revenue: number; count: number }[];
  byType: Record<string, number>;
  topVideos: {
    id: string;
    title: string;
    slug: string | null;
    viewsCount: number;
    likesCount: number;
    purchaseCount: number;
    price: number;
  }[];
  topFans?: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    totalSpent: number;
    purchases: number;
  }[];
}

// Demo fallback so charts are explorable without a database
const DEMO_ANALYTICS: AnalyticsData = {
  totals: {
    publishedVideos: 6,
    totalViews: 140500,
    totalLikes: 11490,
    totalPurchases: 1520,
    pendingBalance: 184000,
    availableBalance: 426000,
    lifetimeEarned: 610000,
    subscribers: 312,
    revenue30d: 96500,
    pendingPayouts: 0,
    conversionRate: 1.1,
  },
  daily: Array.from({ length: 30 }).map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    const base = 1500 + Math.round(Math.sin(i / 3) * 900 + (i % 7) * 260);
    return { date: d.toISOString().slice(0, 10), revenue: Math.max(300, base), count: Math.max(1, Math.round(base / 900)) };
  }),
  byType: { PPV_PURCHASE: 58000, SUBSCRIPTION: 29500, TIP: 9000, OTHER: 0 },
  topVideos: [
    { id: "demo-1", title: "Midnight Sessions — Exclusive Music Video", slug: "midnight-sessions", viewsCount: 24300, likesCount: 1820, purchaseCount: 430, price: 5000 },
    { id: "demo-7", title: "Afro House Mix — Live from Zanzibar", slug: "afro-house-zanzibar", viewsCount: 18900, likesCount: 1540, purchaseCount: 260, price: 4000 },
    { id: "demo-3", title: "Ubuntu Kitchen — Street Food Documentary", slug: "ubuntu-kitchen", viewsCount: 12750, likesCount: 980, purchaseCount: 210, price: 3000 },
    { id: "demo-4", title: "React & Next.js Masterclass for African Developers", slug: "nextjs-masterclass", viewsCount: 8900, likesCount: 760, purchaseCount: 145, price: 12000 },
    { id: "demo-6", title: "Swahili 101 — Beginner Language Course", slug: "swahili-101", viewsCount: 6400, likesCount: 520, purchaseCount: 95, price: 8000 },
  ],
  topFans: [
    { userId: "fan-1", displayName: "Baraka M.", avatarUrl: null, totalSpent: 47000, purchases: 9 },
    { userId: "fan-2", displayName: "Neema K.", avatarUrl: null, totalSpent: 31500, purchases: 6 },
    { userId: "fan-3", displayName: "Juma H.", avatarUrl: null, totalSpent: 22000, purchases: 5 },
    { userId: "fan-4", displayName: "Zawadi R.", avatarUrl: null, totalSpent: 15000, purchases: 3 },
    { userId: "fan-5", displayName: "Frank M.", avatarUrl: null, totalSpent: 9000, purchases: 2 },
  ],
};

export default function CreatorAnalyticsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const { theme } = useTheme();
  const isLight = theme === "light";

  const init = useCallback(async () => {
    try {
      const me = await fetchCurrentUser();
      if (me.status === 401) {
        router.push("/");
        return;
      }
      const meData = await me.json().catch(() => null);
      if (
        meData?.success &&
        meData.data.role !== "CREATOR" &&
        meData.data.role !== "ADMIN"
      ) {
        router.push("/");
        return;
      }
      const res = await fetch("/api/creator/analytics");
      const analytics = await res.json().catch(() => null);
      if (analytics?.success) {
        setData(analytics.data);
        setDemoMode(false);
      } else {
        setData(DEMO_ANALYTICS);
        setDemoMode(true);
      }
    } catch {
      setData(DEMO_ANALYTICS);
      setDemoMode(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    init();
  }, [init]);

  if (loading || !data) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-7xl mx-auto px-4 py-8 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-28 rounded-2xl" />
            ))}
          </div>
          <div className="skeleton h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  const t = data.totals;
  const maxRevenue = Math.max(...data.daily.map((d) => d.revenue), 1);
  const typeTotal = Object.values(data.byType).reduce((a, b) => a + b, 0) || 1;

  const statCards = [
    { label: "Total Views", value: formatCount(t.totalViews), icon: Eye, color: "text-brand-400", bg: "bg-brand-500/20" },
    { label: "Lifetime Earned", value: formatTZS(t.lifetimeEarned), icon: Banknote, color: "text-emerald-400", bg: "bg-emerald-500/20" },
    { label: "Available Balance", value: formatTZS(t.availableBalance), icon: Wallet, color: "text-sky-400", bg: "bg-sky-500/20" },
    { label: "Pending (14 days)", value: formatTZS(t.pendingBalance), icon: TrendingUp, color: "text-amber-400", bg: "bg-amber-500/20" },
    { label: "Active Subscribers", value: t.subscribers.toLocaleString(), icon: Users, color: "text-purple-400", bg: "bg-purple-500/20" },
    { label: "Purchase Rate", value: `${t.conversionRate}%`, icon: ArrowUpRight, color: "text-pink-400", bg: "bg-pink-500/20" },
    { label: "Revenue (30d)", value: formatTZS(t.revenue30d), icon: DollarSign, color: "text-emerald-400", bg: "bg-emerald-500/20" },
    { label: "Published Videos", value: t.publishedVideos.toLocaleString(), icon: BarChart3, color: "text-brand-400", bg: "bg-brand-500/20" },
  ];

  const mix = [
    { label: "Pay-Per-View", value: data.byType.PPV_PURCHASE || 0, color: "bg-brand-500" },
    { label: "Subscriptions", value: data.byType.SUBSCRIPTION || 0, color: "bg-emerald-500" },
    { label: "Tips & Messages", value: (data.byType.TIP || 0) + (data.byType.OTHER || 0), color: "bg-amber-500" },
  ];

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <Link href="/creator" className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-brand-400 transition mb-2">
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Link>
            <h1 className="text-2xl font-display font-bold flex items-center gap-3">
              <BarChart3 className="w-7 h-7 text-brand-400" />
              Analytics
            </h1>
            <p className="text-white/50 text-sm mt-1">Your performance over the last 30 days</p>
          </div>
        </div>

        {demoMode && (
          <div className="rounded-xl px-4 py-3 text-sm border bg-amber-500/10 text-amber-400 border-amber-500/20">
            Demo data is showing — connect a database to see your real numbers.
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((card) => (
            <div key={card.label} className="glass-card p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <card.icon className={`w-4 h-4 ${card.color}`} />
                </div>
                <span className="text-xs text-white/50">{card.label}</span>
              </div>
              <p className="text-lg font-bold truncate">{card.value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Daily revenue chart */}
          <div className="lg:col-span-2 glass-card p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display font-bold">Daily Revenue — Last 30 Days</h2>
              <span className="text-xs text-white/40">creator cut</span>
            </div>

            <div className="flex items-end gap-[3px] h-44">
              {data.daily.map((day) => {
                const height = Math.max(3, Math.round((day.revenue / maxRevenue) * 100));
                return (
                  <div
                    key={day.date}
                    className="flex-1 min-w-0 group relative"
                    style={{ height: `${height}%` }}
                    title={`${day.date}: ${formatTZS(day.revenue)} (${day.count} sales)`}
                  >
                    <div className="w-full h-full rounded-t bg-gradient-to-t from-brand-600 to-brand-400 group-hover:from-brand-500 group-hover:to-brand-300 transition-all" />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-[10px] text-white/30">
              <span>{data.daily[0]?.date}</span>
              <span>{data.daily[Math.floor(data.daily.length / 2)]?.date}</span>
              <span>{data.daily[data.daily.length - 1]?.date}</span>
            </div>
          </div>

          {/* Revenue mix */}
          <div className="glass-card p-6">
            <h2 className="font-display font-bold mb-6">Revenue Mix</h2>
            <div className="space-y-5">
              {mix.map((m) => {
                const pct = Math.round((m.value / typeTotal) * 100);
                return (
                  <div key={m.label}>
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="text-white/60">{m.label}</span>
                      <span className="font-medium">{formatTZS(m.value)}</span>
                    </div>
                    <div className="h-2.5 bg-black/30 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${m.color} rounded-full transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-white/30 mt-1">{pct}% of 30-day revenue</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Top videos + fan leaderboard */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 glass-card p-6">
          <h2 className="font-display font-bold mb-4">Top Videos</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={cn("text-left text-xs border-b", isLight ? "text-white/40 border-white/10" : "text-white/40 border-white/10")}>
                  <th className="pb-3 pr-4">Video</th>
                  <th className="pb-3 px-4 text-right">Views</th>
                  <th className="pb-3 px-4 text-right">Likes</th>
                  <th className="pb-3 px-4 text-right">Sales</th>
                  <th className="pb-3 pl-4 text-right">Est. Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.topVideos.map((v) => (
                  <tr key={v.id} className="border-b border-white/5 last:border-0 hover:bg-white/5 transition">
                    <td className="py-3 pr-4">
                      <Link href={`/video/${v.slug || v.id}`} className="hover:text-brand-400 transition line-clamp-1 max-w-md">
                        {v.title}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-right">{formatCount(v.viewsCount)}</td>
                    <td className="py-3 px-4 text-right">{formatCount(v.likesCount)}</td>
                    <td className="py-3 px-4 text-right">{formatCount(v.purchaseCount)}</td>
                    <td className="py-3 pl-4 text-right font-medium text-emerald-400">
                      {formatTZS(Math.round(v.price * v.purchaseCount * 0.7))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-white/30 mt-3">
            Estimated revenue = price × sales × 70% creator share.
          </p>
        </div>

        {/* Fan leaderboard */}
        <div className="glass-card p-6">
          <h2 className="font-display font-bold mb-1 flex items-center gap-2">
            <Crown className="w-5 h-5 text-amber-400" /> Top Supporters
          </h2>
          <p className="text-xs text-white/40 mb-4">Your biggest spenders, all time</p>
          {(data.topFans || []).length === 0 ? (
            <p className="text-sm text-white/40 py-6 text-center">
              No supporters yet — keep publishing!
            </p>
          ) : (
            <ol className="space-y-3">
              {(data.topFans || []).map((fan, i) => (
                <li key={fan.userId} className="flex items-center gap-3">
                  <span
                    className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
                      i === 0
                        ? "bg-amber-500/20 text-amber-400"
                        : i === 1
                        ? "bg-gray-400/20 text-gray-300"
                        : i === 2
                        ? "bg-orange-600/20 text-orange-400"
                        : "bg-white/5 text-white/40"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 text-xs font-bold shrink-0">
                    {fan.displayName?.[0] || "F"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{fan.displayName}</p>
                    <p className="text-[10px] text-white/40">
                      {fan.purchases} purchase{fan.purchases === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="text-sm font-bold text-emerald-400 shrink-0">
                    {formatTZS(fan.totalSpent)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        </div>
      </main>
    </div>
  );
}
