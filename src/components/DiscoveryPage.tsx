// =============================================================================
// GENHUB - Discovery page shell
// Shared layout for /trending, /top-rated and /most-viewed: hero header with a
// gradient image, the fixed-sort grid, and links to the sibling pages so the
// three work like Brazzers' discovery tabs.
// =============================================================================

import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Flame, Star, Eye, LayoutGrid, Users } from "lucide-react";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import SortGrid from "@/components/SortGrid";

const SIBLINGS = [
  { href: "/trending", label: "Trending", icon: Flame },
  { href: "/top-rated", label: "Top Rated", icon: Star },
  { href: "/most-viewed", label: "Most Viewed", icon: Eye },
  { href: "/browse/all", label: "All Videos", icon: LayoutGrid },
  { href: "/creators", label: "Creators", icon: Users },
];

const ACCENTS: Record<string, { chip: string; badge: string }> = {
  trending: {
    chip: "text-orange-300 bg-orange-500/15 border-orange-500/30",
    badge: "from-orange-500/20",
  },
  rated: {
    chip: "text-amber-300 bg-amber-500/15 border-amber-500/30",
    badge: "from-amber-500/20",
  },
  viewed: {
    chip: "text-sky-300 bg-sky-500/15 border-sky-500/30",
    badge: "from-sky-500/20",
  },
};

export default function DiscoveryPage({
  selfPath,
  badgeLabel,
  title,
  tagline,
  description,
  sort,
  imageSeed,
  emptyMessage,
  accent = "trending",
}: {
  selfPath: string;
  badgeLabel: string;
  title: string;
  tagline: string;
  description: string;
  sort: string;
  imageSeed: string;
  emptyMessage: string;
  accent?: "trending" | "rated" | "viewed";
}) {
  const colors = ACCENTS[accent] ?? ACCENTS.trending;
  const siblings = SIBLINGS.filter((s) => s.href !== selfPath);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-2xl border border-white/10 mb-8">
          <Image
            src={`https://picsum.photos/seed/${imageSeed}/1280/360`}
            alt={title}
            fill
            priority
            sizes="(max-width: 1280px) 100vw, 1200px"
            className="object-cover opacity-40"
          />
          <div className={`absolute inset-0 bg-gradient-to-r ${colors.badge} via-black/80 to-black`} />
          <div className="relative p-6 sm:p-9">
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-semibold border rounded-full px-3 py-1 mb-3 ${colors.chip}`}
            >
              <Flame className="w-3.5 h-3.5" /> {badgeLabel}
            </span>
            <h1 className="font-display font-bold text-2xl sm:text-4xl text-white mb-2">{title}</h1>
            <p className="text-sm sm:text-base text-gray-300 max-w-2xl">{description}</p>
            <p className="mt-3 text-xs uppercase tracking-wide text-white/40">{tagline}</p>
          </div>
        </div>

        {/* Grid */}
        <SortGrid sort={sort} emptyMessage={emptyMessage} />

        {/* Siblings */}
        <nav aria-label="More discovery" className="mt-14 pt-8 border-t border-white/10">
          <h2 className="font-display font-bold text-lg text-white mb-4">Keep exploring</h2>
          <div className="flex flex-wrap gap-2">
            {siblings.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="group inline-flex items-center gap-2 text-sm px-4 py-2 rounded-full border border-white/10 bg-white/5 text-gray-300 hover:border-brand-500 hover:text-white transition"
              >
                <s.icon className="w-4 h-4" />
                {s.label}
                <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition" />
              </Link>
            ))}
          </div>
        </nav>
      </div>
      <BottomNav />
    </div>
  );
}
