// =============================================================================
// GENHUB - What the site is doing right now (public)
// GET /api/site/status
//
// The banner, and the honest pauses: whether uploads and mobile-money checkout
// are switched on. Public because the banner and the paywall/wallet screens are
// shown to signed-out visitors.
//
// Carries no secret and names no key — only the three booleans an operator has
// chosen and the banner text they wrote to be read by everyone anyway.
// =============================================================================

import { api } from "@/lib/api-response";
import { getAnnouncement, getFeatureFlags } from "@/lib/services/platform-setting.service";

export const dynamic = "force-dynamic";

export async function GET() {
  const [flags, announcement] = await Promise.all([getFeatureFlags(), getAnnouncement()]);

  return api.success({
    uploadsEnabled: flags.uploadsEnabled,
    checkoutEnabled: flags.checkoutEnabled,
    announcement,
  });
}
