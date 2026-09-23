// =============================================================================
// GENHUB - Top Rated page
// Highest rated scenes by viewer likes (sort=rated on /api/videos).
// =============================================================================

import type { Metadata } from "next";
import DiscoveryPage from "@/components/DiscoveryPage";

const TITLE = "Top Rated Videos";
const DESCRIPTION =
  "The highest rated scenes on Genhub, ordered by what viewers liked most.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/top-rated" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/top-rated",
    siteName: "Genhub",
    type: "website",
  },
};

export default function TopRatedPage() {
  return (
    <DiscoveryPage
      selfPath="/top-rated"
      badgeLabel="Best of the best"
      title="Top Rated"
      tagline="Ranked by viewer likes"
      description={DESCRIPTION}
      sort="rated"
      imageSeed="genhub-toprated"
      accent="rated"
      emptyMessage="No ratings yet — be the first to like a scene."
    />
  );
}
