// =============================================================================
// GENHUB - Trending page
// What the whole platform is watching right now: recent views, purchases and
// likes scored together (see lib/trending).
// =============================================================================

import type { Metadata } from "next";
import DiscoveryPage from "@/components/DiscoveryPage";

const TITLE = "Trending Videos";
const DESCRIPTION =
  "The scenes everyone is watching on Genhub right now — scored by fresh views, purchases and likes.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/trending" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/trending",
    siteName: "Genhub",
    type: "website",
  },
};

export default function TrendingPage() {
  return (
    <DiscoveryPage
      selfPath="/trending"
      badgeLabel="Hot right now"
      title="Trending on Genhub"
      tagline="Updated continuously"
      description={DESCRIPTION}
      sort="trending"
      imageSeed="genhub-trending"
      accent="trending"
      emptyMessage="Nothing is trending yet — check back in a few minutes."
    />
  );
}
