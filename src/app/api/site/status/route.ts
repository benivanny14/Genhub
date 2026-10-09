// =============================================================================
// GENHUB - What the site is doing right now (public)
// GET /api/site/status
//
// The banner, the honest pauses (whether uploads and mobile-money checkout are
// switched on), the "everything is free right now" switch that viewer screens
// read to keep prices off the page, and the address of the clip behind every
// page. Public because the banner, the paywall/wallet screens and the backdrop
// are all shown to signed-out visitors.
//
// Carries no secret and names no key — only the booleans an operator has chosen,
// the banner text they wrote to be read by everyone anyway, and never a price
// decision that could open paid content. The background video answers with a
// token and a media type; the file itself is read from its own route.
// =============================================================================

import { api } from "@/lib/api-response";
import {
  getAnnouncement,
  getBackgroundVideo,
  getFeatureFlags,
  getAllVideosFree,
} from "@/lib/services/platform-setting.service";

export const dynamic = "force-dynamic";

export async function GET() {
  const [flags, announcement, allVideosFree, backgroundVideo] = await Promise.all([
    getFeatureFlags(),
    getAnnouncement(),
    getAllVideosFree(),
    getBackgroundVideo(),
  ]);

  return api.success({
    uploadsEnabled: flags.uploadsEnabled,
    checkoutEnabled: flags.checkoutEnabled,
    // The platform-wide "everything is free right now" switch. Public because
    // the viewer-facing screens (video cards, the paywall, the search shelf)
    // read it to STOP SHOWING PRICES while the promotion is on — a price on a
    // scene nobody is being asked to pay for is the thing this flag removes.
    // Turning it off brings the prices straight back.
    allVideosFree,
    announcement,
    backgroundVideo,
  });
}
