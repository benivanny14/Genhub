// =============================================================================
// GENHUB - Most Viewed page
// All-time play counts (sort=popular on /api/videos).
// =============================================================================

import type { Metadata } from "next";
import DiscoveryPage from "@/components/DiscoveryPage";

const TITLE = "Most Viewed Videos";
const DESCRIPTION =
  "The most watched scenes on Genhub — ordered by all-time view count.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/most-viewed" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/most-viewed",
    siteName: "Genhub",
    type: "website",
  },
};

export default function MostViewedPage() {
  return (
    <DiscoveryPage
      selfPath="/most-viewed"
      badgeLabel="All-time favourites"
      title="Most Viewed"
      tagline="Ordered by total views"
      description={DESCRIPTION}
      sort="popular"
      imageSeed="genhub-mostviewed"
      accent="viewed"
      emptyMessage="No views logged yet — the counters start as soon as people watch."
    />
  );
}
