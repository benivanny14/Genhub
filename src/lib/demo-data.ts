// =============================================================================
// GENHUB - Demo seed data
// Used as a fallback feed when the database is not reachable (local dev),
// and by POST /api/demo/seed to populate a fresh database.
// =============================================================================

import { trendingScore } from "@/lib/trending";

export interface DemoCreator {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  isVerified: boolean;
}

export interface DemoVideo {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  price: number;
  teaserDuration: number;
  duration: number | null;
  viewsCount: number;
  likesCount: number;
  dislikesCount?: number;
  purchaseCount: number;
  category: string | null;
  isPremium: boolean;
  isFeatured: boolean;
  tags: string[];
  hasAccess: boolean;
  playbackUrl: string | null;
  /** The main stored stream (seed maps this to Video.previewUrl). */
  teaserUrl: string | null;
  /**
   * A SEPARATE short trailer for non-buyers (seed maps to Video.teaserClipUrl).
   * Assigned for every video by the forEach below, so it is not repeated in all
   * 24 literals.
   */
  teaserClipUrl?: string | null;
  createdAt: string;
  creator: DemoCreator;
}

const daysAgo = (d: number) =>
  new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

const thumb = (seed: string) =>
  `https://picsum.photos/seed/${seed}/640/360`;

export const DEMO_CREATORS: DemoCreator[] = [
  { id: "demo-creator-1", displayName: "Amani Styles", avatarUrl: null, isVerified: true },
  { id: "demo-creator-2", displayName: "Kili Beats", avatarUrl: null, isVerified: true },
  { id: "demo-creator-3", displayName: "Zoe Comedy", avatarUrl: null, isVerified: false },
  { id: "demo-creator-4", displayName: "Sanaa Tech", avatarUrl: null, isVerified: true },
  { id: "demo-creator-5", displayName: "Msafari Sports", avatarUrl: null, isVerified: false },
];

export const DEMO_VIDEOS: DemoVideo[] = [
  {
    id: "demo-1",
    title: "Midnight Sessions — Exclusive Music Video",
    slug: "midnight-sessions",
    description:
      "A cinematic music experience filmed in Dar es Salaam. Premium 4K release for Genhub members.",
    thumbnailUrl: thumb("genhub-music"),
    price: 5000,
    teaserDuration: 15,
    duration: 312,
    viewsCount: 24300,
    likesCount: 1820,
    purchaseCount: 430,
    category: "music",
    isPremium: true,
    isFeatured: true,
    tags: ["music", "exclusive", "4k"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(2),
    creator: DEMO_CREATORS[0],
  },
  {
    id: "demo-2",
    title: "Behind the Scenes — Comedy Special Outtakes",
    slug: "comedy-bts",
    description: "The funniest moments that never made it to the final cut.",
    thumbnailUrl: thumb("genhub-comedy"),
    price: 0,
    teaserDuration: 20,
    duration: 545,
    viewsCount: 51200,
    likesCount: 4100,
    purchaseCount: 0,
    category: "comedy",
    isPremium: false,
    isFeatured: false,
    tags: ["comedy", "bts"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(4),
    creator: DEMO_CREATORS[2],
  },
  {
    id: "demo-3",
    title: "Ubuntu Kitchen — Street Food Documentary",
    slug: "ubuntu-kitchen",
    description: "A journey through the street food culture of East Africa.",
    thumbnailUrl: thumb("genhub-food"),
    price: 3000,
    teaserDuration: 15,
    duration: 1260,
    viewsCount: 12750,
    likesCount: 980,
    purchaseCount: 210,
    category: "lifestyle",
    isPremium: true,
    isFeatured: true,
    tags: ["documentary", "food", "lifestyle"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(6),
    creator: DEMO_CREATORS[1],
  },
  {
    id: "demo-4",
    title: "React & Next.js Masterclass for African Developers",
    slug: "nextjs-masterclass",
    description:
      "Full modern web development course — deploy your first app in under an hour.",
    thumbnailUrl: thumb("genhub-tech"),
    price: 12000,
    teaserDuration: 30,
    duration: 3480,
    viewsCount: 8900,
    likesCount: 760,
    purchaseCount: 145,
    category: "tech",
    isPremium: true,
    isFeatured: false,
    tags: ["tech", "education", "coding"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(8),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-5",
    title: "Championship Finals — Full Highlights",
    slug: "championship-finals",
    description: "Every goal, every moment from the regional championship final.",
    thumbnailUrl: thumb("genhub-sports"),
    price: 2000,
    teaserDuration: 15,
    duration: 720,
    viewsCount: 33100,
    likesCount: 2500,
    purchaseCount: 380,
    category: "sports",
    isPremium: false,
    isFeatured: true,
    tags: ["sports", "highlights"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(1),
    creator: DEMO_CREATORS[4],
  },
  {
    id: "demo-6",
    title: "Swahili 101 — Beginner Language Course",
    slug: "swahili-101",
    description: "Learn conversational Swahili with native speakers.",
    thumbnailUrl: thumb("genhub-edu"),
    price: 8000,
    teaserDuration: 20,
    duration: 2100,
    viewsCount: 6400,
    likesCount: 520,
    purchaseCount: 95,
    category: "education",
    isPremium: true,
    isFeatured: false,
    tags: ["education", "language"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(10),
    creator: DEMO_CREATORS[1],
  },
  {
    id: "demo-7",
    title: "Afro House Mix — Live from Zanzibar",
    slug: "afro-house-zanzibar",
    description: "A two-hour live DJ set on the beaches of Zanzibar.",
    thumbnailUrl: thumb("genhub-mix"),
    price: 4000,
    teaserDuration: 15,
    duration: 7320,
    viewsCount: 18900,
    likesCount: 1540,
    purchaseCount: 260,
    category: "music",
    isPremium: true,
    isFeatured: true,
    tags: ["music", "dj", "live"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(3),
    creator: DEMO_CREATORS[0],
  },
  {
    id: "demo-8",
    title: "Startup Diaries — Building in East Africa",
    slug: "startup-diaries",
    description: "Founders share what it really takes to build a tech company in the region.",
    thumbnailUrl: thumb("genhub-startup"),
    price: 0,
    teaserDuration: 20,
    duration: 1680,
    viewsCount: 4700,
    likesCount: 390,
    purchaseCount: 0,
    category: "tech",
    isPremium: false,
    isFeatured: false,
    tags: ["tech", "startup", "interview"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(12),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-9",
    title: "Bongo Flava Top 20 — Weekly Countdown",
    slug: "bongo-flava-top-20",
    description: "This week's biggest tracks from East Africa's charts, ranked and reviewed.",
    thumbnailUrl: thumb("genhub-countdown"),
    price: 1500,
    teaserDuration: 15,
    duration: 1620,
    viewsCount: 21400,
    likesCount: 1710,
    purchaseCount: 190,
    category: "music",
    isPremium: true,
    isFeatured: false,
    tags: ["music", "charts", "countdown"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(5),
    creator: DEMO_CREATORS[0],
  },
  {
    id: "demo-10",
    title: "Kitchen Secrets — Ugali & Nyama Choma",
    slug: "kitchen-secrets-ugali",
    description: "Step-by-step traditional BBQ techniques from a Dar es Salaam street chef.",
    thumbnailUrl: thumb("genhub-kitchen"),
    price: 0,
    teaserDuration: 20,
    duration: 980,
    viewsCount: 40200,
    likesCount: 3300,
    purchaseCount: 0,
    category: "lifestyle",
    isPremium: false,
    isFeatured: false,
    tags: ["food", "cooking", "lifestyle"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(7),
    creator: DEMO_CREATORS[1],
  },
  {
    id: "demo-11",
    title: "Data Science with Python — Lesson 1",
    slug: "data-science-python-1",
    description: "From raw CSV to your first chart — no experience required.",
    thumbnailUrl: thumb("genhub-datasci"),
    price: 7000,
    teaserDuration: 30,
    duration: 2760,
    viewsCount: 5300,
    likesCount: 470,
    purchaseCount: 78,
    category: "tech",
    isPremium: true,
    isFeatured: false,
    tags: ["tech", "education", "python"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(9),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-12",
    title: "Derby Day — Simba vs Young Africans",
    slug: "derby-day-highlights",
    description: "Every angle of the biggest derby in East African football.",
    thumbnailUrl: thumb("genhub-derby"),
    price: 2500,
    teaserDuration: 15,
    duration: 1140,
    viewsCount: 58700,
    likesCount: 4900,
    purchaseCount: 420,
    category: "sports",
    isPremium: false,
    isFeatured: true,
    tags: ["sports", "football", "highlights"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(3),
    creator: DEMO_CREATORS[4],
  },
  {
    id: "demo-13",
    title: "Standup Night — Dar es Salaam Live",
    slug: "standup-night-dar",
    description: "Six comedians, one stage, zero filter. Filmed live at Warehouse 26.",
    thumbnailUrl: thumb("genhub-standup"),
    price: 1000,
    teaserDuration: 15,
    duration: 3300,
    viewsCount: 16800,
    likesCount: 1420,
    purchaseCount: 155,
    category: "comedy",
    isPremium: true,
    isFeatured: false,
    tags: ["comedy", "standup", "live"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(11),
    creator: DEMO_CREATORS[2],
  },
  {
    id: "demo-14",
    title: "Acoustic Sunset — Live at Mbudya",
    slug: "acoustic-sunset-mbudya",
    description: "A stripped-back beach session as the sun goes down over the Indian Ocean.",
    thumbnailUrl: thumb("genhub-acoustic"),
    price: 3500,
    teaserDuration: 15,
    duration: 2040,
    viewsCount: 13600,
    likesCount: 1150,
    purchaseCount: 132,
    category: "music",
    isPremium: true,
    isFeatured: false,
    tags: ["music", "acoustic", "live"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(14),
    creator: DEMO_CREATORS[0],
  },
  {
    id: "demo-15",
    title: "Photography Basics — Shooting the Golden Hour",
    slug: "photography-golden-hour",
    description: "Camera settings, light and composition — practical, not theoretical.",
    thumbnailUrl: thumb("genhub-photo"),
    price: 0,
    teaserDuration: 20,
    duration: 1440,
    viewsCount: 9800,
    likesCount: 840,
    purchaseCount: 0,
    category: "education",
    isPremium: false,
    isFeatured: false,
    tags: ["education", "photography", "tutorial"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(16),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-16",
    title: "Zanzibar Travel Guide — 48 Hours",
    slug: "zanzibar-48-hours",
    description: "Stone Town, spice farms and the best beaches — a full weekend itinerary.",
    thumbnailUrl: thumb("genhub-zanzibar"),
    price: 2000,
    teaserDuration: 15,
    duration: 1560,
    viewsCount: 27300,
    likesCount: 2210,
    purchaseCount: 240,
    category: "lifestyle",
    isPremium: false,
    isFeatured: true,
    tags: ["travel", "lifestyle", "zanzibar"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(18),
    creator: DEMO_CREATORS[1],
  },
  {
    id: "demo-17",
    title: "Basketball Premier League — Week 6 Highlights",
    slug: "basketball-week-6",
    description: "Buzzer beaters and breakaways from the weekend's round of games.",
    thumbnailUrl: thumb("genhub-basket"),
    price: 1800,
    teaserDuration: 15,
    duration: 660,
    viewsCount: 11200,
    likesCount: 910,
    purchaseCount: 88,
    category: "sports",
    isPremium: false,
    isFeatured: false,
    tags: ["sports", "basketball", "highlights"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(4),
    creator: DEMO_CREATORS[4],
  },
  {
    id: "demo-18",
    title: "Coding Interview Prep — Arrays & Strings",
    slug: "coding-interview-arrays",
    description: "The 12 patterns that cover most junior-to-mid interview questions.",
    thumbnailUrl: thumb("genhub-interview"),
    price: 5000,
    teaserDuration: 30,
    duration: 3120,
    viewsCount: 7400,
    likesCount: 620,
    purchaseCount: 64,
    category: "tech",
    isPremium: true,
    isFeatured: false,
    tags: ["tech", "career", "coding"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(20),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-19",
    title: "Fashion Week Dar — Behind the Runway",
    slug: "fashion-week-dar",
    description: "Designers, models and the 48 hours before the doors open.",
    thumbnailUrl: thumb("genhub-fashion"),
    price: 4500,
    teaserDuration: 15,
    duration: 1860,
    viewsCount: 15900,
    likesCount: 1330,
    purchaseCount: 121,
    category: "lifestyle",
    isPremium: true,
    isFeatured: false,
    tags: ["fashion", "lifestyle", "documentary"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(13),
    creator: DEMO_CREATORS[2],
  },
  {
    id: "demo-20",
    title: "Comedy Skits — Compilation #12",
    slug: "comedy-skits-12",
    description: "The twelve funniest shorts from this season, back to back.",
    thumbnailUrl: thumb("genhub-skits"),
    price: 0,
    teaserDuration: 20,
    duration: 780,
    viewsCount: 62100,
    likesCount: 5400,
    purchaseCount: 0,
    category: "comedy",
    isPremium: false,
    isFeatured: false,
    tags: ["comedy", "skits", "compilation"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(6),
    creator: DEMO_CREATORS[2],
  },
  {
    id: "demo-21",
    title: "Afrobeat Mixtape — Late Night Drive",
    slug: "afrobeat-late-night",
    description: "Sixty minutes of smooth Afrobeat for the long road home.",
    thumbnailUrl: thumb("genhub-latnight"),
    price: 2200,
    teaserDuration: 15,
    duration: 3660,
    viewsCount: 19700,
    likesCount: 1640,
    purchaseCount: 174,
    category: "music",
    isPremium: true,
    isFeatured: false,
    tags: ["music", "afrobeat", "mixtape"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(8),
    creator: DEMO_CREATORS[0],
  },
  {
    id: "demo-22",
    title: "Startup Pitch Day — East Africa Finals",
    slug: "startup-pitch-finals",
    description: "Ten teams, five investors, one term sheet. The full finals recording.",
    thumbnailUrl: thumb("genhub-pitchday"),
    price: 0,
    teaserDuration: 20,
    duration: 4500,
    viewsCount: 6100,
    likesCount: 510,
    purchaseCount: 0,
    category: "tech",
    isPremium: false,
    isFeatured: false,
    tags: ["tech", "startup", "pitch"],
    hasAccess: true,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(22),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-23",
    title: "Advanced CSS — Grid & Container Queries",
    slug: "advanced-css-grid",
    description: "Layout techniques that survive real production deadlines.",
    thumbnailUrl: thumb("genhub-css"),
    price: 6000,
    teaserDuration: 30,
    duration: 2400,
    viewsCount: 4900,
    likesCount: 430,
    purchaseCount: 52,
    category: "tech",
    isPremium: true,
    isFeatured: false,
    tags: ["tech", "css", "education"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(25),
    creator: DEMO_CREATORS[3],
  },
  {
    id: "demo-24",
    title: "Serengeti — The Great Migration",
    slug: "serengeti-migration",
    description: "Two million animals, one river crossing. Filmed over eleven months.",
    thumbnailUrl: thumb("genhub-serengeti"),
    price: 3000,
    teaserDuration: 15,
    duration: 3000,
    viewsCount: 35800,
    likesCount: 3050,
    purchaseCount: 295,
    category: "lifestyle",
    isPremium: true,
    isFeatured: true,
    tags: ["documentary", "wildlife", "nature"],
    hasAccess: false,
    playbackUrl: null,
    teaserUrl: null,
    createdAt: daysAgo(10),
    creator: DEMO_CREATORS[4],
  },
];

// Publicly available sample HLS streams used so demo videos actually play.
// These are the FULL scenes.
const SAMPLE_HLS_STREAMS = [
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "https://test-streams.mux.dev/tearsofsteel/tearsofsteel.m3u8",
  "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
  "https://test-streams.mux.dev/pts_shift/master.m3u8",
];

// Trailer clips for non-buyers — a DIFFERENT asset from the scene above, which
// is the whole point of the teaser feature: a Bunny token authorises a path and
// cannot limit duration, so previewing a scene by signing it gives it away.
//
// Every URL here was fetched and checked (HTTP 200, #EXTM3U, VOD with an
// ENDLIST) and is deliberately SHORT, so a hover preview reads as a trailer:
//
//   angel-one-hls          1m00s
//   dai-discontinuity      4m26s
//   bbb-dark-truths        6m12s
//   test_001               8m30s
//
// They are disjoint from SAMPLE_HLS_STREAMS, and the assertion at the bottom of
// this block keeps that true — if a future edit made them overlap, a paid scene
// would silently be handed to non-buyers in full.
const TEASER_HLS_STREAMS = [
  "https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8",
  "https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8",
  "https://storage.googleapis.com/shaka-demo-assets/bbb-dark-truths-hls/hls.m3u8",
  "https://test-streams.mux.dev/test_001/stream.m3u8",
];

// Every demo video gets a playable stream plus a separate trailer.
DEMO_VIDEOS.forEach((video, index) => {
  const stream = SAMPLE_HLS_STREAMS[index % SAMPLE_HLS_STREAMS.length];
  const teaser = TEASER_HLS_STREAMS[index % TEASER_HLS_STREAMS.length];

  // Never let the trailer be the scene. The arrays are disjoint by
  // construction; if someone edits them into overlap, fall to the next trailer
  // rather than shipping a demo whose paywall leaks the full video.
  video.teaserClipUrl =
    teaser === stream
      ? TEASER_HLS_STREAMS[(index + 1) % TEASER_HLS_STREAMS.length]
      : teaser;

  // `teaserUrl` here is historical naming: it is the MAIN stored stream, and the
  // seed maps it to Video.previewUrl. The trailer goes in its own field.
  video.teaserUrl = stream;
  video.playbackUrl = stream;
  video.dislikesCount = Math.max(1, Math.round(video.likesCount / 9));
});

// =============================================================================
// Feed mapping
//
// The raw records above carry the FULL scene in `teaserUrl` (the seed maps that
// field to Video.previewUrl) and the trailer in `teaserClipUrl`. The feed shape
// the UI consumes is the opposite: `teaserUrl` there means what a NON-BUYER may
// play. Handing the raw field straight through would put every paid demo scene
// on the homepage for anyone to watch.
//
// Exported as a function rather than inlined in the page so it can be tested
// directly — mirrors resolveTeaserUrl in lib/bunny.ts.
// =============================================================================
export function demoTeaserFor(video: DemoVideo): string | null {
  return video.teaserClipUrl ?? (video.price === 0 ? video.playbackUrl : null);
}

/** Raw demo record -> the shape the feed/components expect. */
export function toFeedVideo(video: DemoVideo): DemoVideo {
  return { ...video, teaserUrl: demoTeaserFor(video) };
}

export function filterDemoVideos(opts: {
  q?: string;
  category?: string;
  sort?: string;
  duration?: string; // short | medium | long
  date?: string; // day | week | month | year
}): DemoVideo[] {
  let list = [...DEMO_VIDEOS];

  if (opts.q) {
    const q = opts.q.toLowerCase();
    list = list.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        v.creator.displayName.toLowerCase().includes(q) ||
        v.tags.some((t) => t.includes(q))
    );
  }

  if (opts.category) {
    list = list.filter((v) => v.category === opts.category);
  }

  if (opts.duration) {
    list = list.filter((v) => {
      const d = v.duration || 0;
      if (opts.duration === "short") return d < 300;
      if (opts.duration === "medium") return d >= 300 && d < 1200;
      if (opts.duration === "long") return d >= 1200;
      return true;
    });
  }

  if (opts.date) {
    const now = Date.now();
    const limits: Record<string, number> = {
      day: 1,
      week: 7,
      month: 30,
      year: 365,
    };
    const days = limits[opts.date];
    if (days) {
      list = list.filter(
        (v) => now - new Date(v.createdAt).getTime() <= days * 86400000
      );
    }
  }

  switch (opts.sort) {
    case "popular":
      list.sort((a, b) => b.viewsCount - a.viewsCount);
      break;
    case "price_low":
      list.sort((a, b) => a.price - b.price);
      break;
    case "price_high":
      list.sort((a, b) => b.price - a.price);
      break;
    case "trending": {
      // Shared smart-trending score: engagement weighted by recency
      const now = Date.now();
      list.sort((a, b) => trendingScore(b, now) - trendingScore(a, now));
      break;
    }
    default:
      list.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  return list;
}
