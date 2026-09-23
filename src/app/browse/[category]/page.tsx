// =============================================================================
// GENHUB - Browse Category page (SEO)
// GET /browse/[category] - Public, shareable category listing with its own
// URL, title, description and OG tags. Renders the client BrowseGrid below.
// =============================================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { LayoutGrid, ArrowRight } from "lucide-react";
import { CATEGORIES, getCategory, categoryHref } from "@/lib/categories";
import BrowseGrid from "./BrowseGrid";

interface Props {
  params: { category: string };
}

// Prerender every category page at build time
export function generateStaticParams() {
  return CATEGORIES.map((c) => ({ category: c.id }));
}

export function generateMetadata({ params }: Props): Promise<Metadata> {
  const category = getCategory(params.category);
  // Layout applies the "%s | Genhub" title template — don't repeat the brand
  if (!category) return Promise.resolve({ title: "Category not found" });

  const title = `${category.label} Videos`;
  const image = `https://picsum.photos/seed/${category.imageSeed}/1200/630`;

  return Promise.resolve({
    title,
    description: category.description,
    alternates: { canonical: categoryHref(category.id) },
    openGraph: {
      title,
      description: category.description,
      url: categoryHref(category.id),
      siteName: "Genhub",
      type: "website",
      images: [{ url: image, width: 1200, height: 630, alt: `${category.label} videos` }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: category.description,
      images: [image],
    },
  });
}

export default function BrowseCategoryPage({ params }: Props) {
  const category = getCategory(params.category);
  if (!category) notFound();

  const others = CATEGORIES.filter((c) => c.id !== category.id);

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Hero header */}
        <div className="relative overflow-hidden rounded-2xl border border-white/10 mb-8">
          <Image
            src={`https://picsum.photos/seed/${category.imageSeed}/1280/360`}
            alt={category.label}
            fill
            priority
            sizes="(max-width: 1280px) 100vw, 1200px"
            className="object-cover opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
          <div className="relative p-6 sm:p-9">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-300 bg-brand-500/15 border border-brand-500/30 rounded-full px-3 py-1 mb-3">
              <LayoutGrid className="w-3.5 h-3.5" /> Category
            </span>
            <h1 className="font-display font-bold text-2xl sm:text-4xl text-white mb-2">
              {category.label}
            </h1>
            <p className="text-sm sm:text-base text-gray-300 max-w-2xl">
              {category.description}
            </p>
          </div>
        </div>

        {/* Grid */}
        <BrowseGrid
          category={category.id === "all" ? "" : category.id}
          label={category.label}
        />

        {/* Other categories */}
        <nav aria-label="Other categories" className="mt-14 pt-8 border-t border-white/10">
          <h2 className="font-display font-bold text-lg text-white mb-4">
            More categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {others.map((c) => (
              <Link
                key={c.id}
                href={categoryHref(c.id)}
                className="group inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-white/10 bg-white/5 text-gray-300 hover:border-brand-500 hover:text-white transition"
              >
                {c.label}
                <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition" />
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
