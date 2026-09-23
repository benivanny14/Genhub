// =============================================================================
// GENHUB - robots.txt
// Allows crawlers everywhere except private/dashboard/API surfaces and points
// them at the sitemap.
// =============================================================================

import type { MetadataRoute } from "next";
import config from "@/lib/config";

export default function robots(): MetadataRoute.Robots {
  const base = config.appUrl.replace(/\/$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/admin",
          "/inbox",
          "/wallet",
          "/profile",
          "/favorites",
          "/feed",
          "/creator/analytics",
          "/creator/upload",
          "/creator/kyc",
          "/creator/balance",
          "/creator/payouts",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
