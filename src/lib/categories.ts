// =============================================================================
// GENHUB - Public category registry
// Single source of truth for the browsable categories: home tiles,
// /browse/[category] pages (SEO + generateStaticParams) and the filter chips.
// =============================================================================

export interface CategoryDef {
  /** URL segment used by /browse/[category] */
  id: string;
  /** Human label shown on tiles, pages and chips */
  label: string;
  /** One-line SEO description for the browse page */
  description: string;
  /** Deterministic thumbnail seed (picsum) for the tile/OG image */
  imageSeed: string;
}

/** "all" is a pseudo-category: it maps to an empty category filter. */
export const CATEGORIES: CategoryDef[] = [
  {
    id: "all",
    label: "All Videos",
    description: "Browse every published video on Genhub — music, comedy, sports, tech and more.",
    imageSeed: "genhub-all",
  },
  {
    id: "music",
    label: "Music",
    description: "Music videos, live sets, mixes and performances from East African creators.",
    imageSeed: "genhub-music",
  },
  {
    id: "comedy",
    label: "Comedy",
    description: "The funniest skits, stand-up and comedy compilations on Genhub.",
    imageSeed: "genhub-comedy",
  },
  {
    id: "education",
    label: "Education",
    description: "Learn something new — tutorials, courses and educational videos on Genhub.",
    imageSeed: "genhub-edu",
  },
  {
    id: "sports",
    label: "Sports",
    description: "Match highlights, tournaments and sports documentaries on Genhub.",
    imageSeed: "genhub-sports",
  },
  {
    id: "lifestyle",
    label: "Lifestyle",
    description: "Food, travel, fashion and everyday lifestyle videos from creators you love.",
    imageSeed: "genhub-food",
  },
  {
    id: "tech",
    label: "Tech",
    description: "Gadget reviews, coding tutorials and tech talk from East African creators.",
    imageSeed: "genhub-tech",
  },
  {
    id: "exclusive",
    label: "Exclusive",
    description: "Premium, members-only videos you won't find anywhere else.",
    imageSeed: "genhub-premium",
  },
];

export const CATEGORY_IDS: string[] = CATEGORIES.map((c) => c.id);

export function getCategory(id: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Browse page for a category ("all" for everything). */
export function categoryHref(id: string): string {
  return `/browse/${id || "all"}`;
}

/** The category param /api/videos expects ("all" => no filter). */
export function categoryFilter(id: string): string {
  return !id || id === "all" ? "" : id;
}
