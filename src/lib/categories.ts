// =============================================================================
// GENHUB - Public category registry
// Single source of truth for the browsable categories: home tiles,
// /browse/[category] pages (SEO + generateStaticParams) and the filter chips.
//
// The list is defined once, as [id, label, description?] rows. `id` is the
// slug that appears in the URL and is what gets stored on `Video.category`, so
// it must stay stable even if a label is reworded later.
// =============================================================================

export interface CategoryDef {
  /** URL segment used by /browse/[category] and stored on Video.category */
  id: string;
  /** Human label shown on tiles, pages and chips */
  label: string;
  /** One-line SEO description for the browse page */
  description: string;
  /** Deterministic thumbnail seed (picsum) for the tile/OG image */
  imageSeed: string;
}

/**
 * [id, label, description?]
 *
 * "all" is a pseudo-category: it maps to an empty category filter.
 */
const RAW_CATEGORIES: Array<[string, string, string?]> = [
  [
    "all",
    "All Videos",
    "Browse every published scene on Genhub — the full catalogue in one place.",
  ],

  // ── Performers & orientation ────────────────────────────────────────────
  ["solo-female", "Solo Female"],
  ["solo-male", "Solo Male"],
  ["couples-straight", "Couples / Straight"],
  ["lesbian", "Lesbian"],
  ["gay", "Gay"],
  ["bisexual", "Bisexual"],
  ["trans-female", "Trans Female"],
  ["trans-male", "Trans Male"],

  // ── Group scenes ────────────────────────────────────────────────────────
  ["threesome-mff", "Threesome (MFF)"],
  ["threesome-mmf", "Threesome (MMF)"],
  ["threesome-fff-mmm", "Threesome (FFF / MMM)"],
  ["foursome", "Foursome"],
  ["orgy-group", "Orgy / Group"],
  ["gangbang", "Gangbang"],
  ["reverse-gangbang", "Reverse Gangbang"],
  ["double-penetration", "Double Penetration (DP)"],
  ["triple-penetration", "Triple Penetration (TP)"],
  ["cuckold-hotwife", "Cuckold / Hotwife"],

  // ── Intensity & styles ──────────────────────────────────────────────────
  ["hardcore", "Hardcore"],
  ["softcore", "Softcore"],
  ["anal", "Anal"],
  ["pegging", "Pegging"],
  ["blowjob", "Blowjob / Fellatio"],
  ["cunnilingus", "Cunnilingus / Eating Out"],
  ["deepthroat", "Deepthroat"],
  ["facial", "Facial"],
  ["handjob", "Handjob"],
  ["footjob", "Footjob"],
  ["creampie", "Creampie"],
  ["swallow", "Swallow / Internal Cumshot"],
  ["squirt", "Squirt / Female Ejaculation"],
  ["masturbation", "Masturbation"],
  ["sixty-nine", "69 (Sixty-Nine)"],
  ["rimming", "Anilingus / Rimming"],
  ["tittyfuck", "Tittyfuck / Intermammary"],
  ["foot-fetish", "Foot Fetish"],

  // ── Kink & fetish ───────────────────────────────────────────────────────
  ["bdsm", "BDSM / Bondage"],
  ["dom-sub", "Dominance & Submission (Dom/Sub)"],
  ["spanking", "Spanking / Slapping"],
  ["gagging", "Gagging / Throatplay"],
  ["outdoor", "Outdoor / Public"],
  ["exhibitionism", "Exhibitionism"],
  ["voyeurism", "Voyeurism"],
  ["gloryhole", "Gloryhole"],

  // ── Props, wardrobe & ambiance ──────────────────────────────────────────
  ["toys", "Toys / Vibrators"],
  ["lingerie", "Lingerie / Stockings / High Heels"],
  ["oil", "Oil / Lotion / Wet"],
  ["striptease", "Striptease / Pole Dancing"],
  ["asmr", "ASMR / Audio Porn"],

  // ── Everyday / soft settings ────────────────────────────────────────────
  ["masturbating", "Masturbating"],
  ["orgasm", "Orgasm"],
  ["massage", "Massage"],
  ["bedroom", "Bedroom"],
  ["washing-room", "Washing Room"],
  ["sitting-room", "Sitting Room"],
];

export const CATEGORIES: CategoryDef[] = RAW_CATEGORIES.map(([id, label, description]) => ({
  id,
  label,
  description:
    description ??
    `Watch ${label} videos on Genhub — premium scenes from verified creators.`,
  imageSeed: `genhub-${id}`,
}));

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
