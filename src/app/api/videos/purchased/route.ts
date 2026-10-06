// =============================================================================
// GENHUB - The scenes THIS viewer has already paid for
// GET /api/videos/purchased
//
// The ids of the viewer's live access rows. Viewer screens read it once per page
// so a card for a scene the viewer owns can say PAID instead of quoting a price
// they have already paid — "buy this" and "you own this" look identical on a
// grid of covers otherwise, and the one a buyer needs is the second one.
//
// PER-ACCOUNT, so `privateSuccess` (`no-store`): a cache handing one fan's list
// to the next visitor would tell them what somebody else bought. Signed out is
// not an error — it is an empty list, because a visitor who cannot buy anything
// has nothing marked, and a 401 here would be noise on every public page.
//
// LIVE ACCESS ONLY, matching resolveVideoEntitlement: a lifetime row, or a
// rental that has not run out. An expired row is not a purchase any more, so the
// card must go back to showing the price.
//
// It deliberately does NOT include scenes a subscription covers: those were not
// paid for individually, and marking them "PAID" would claim a purchase that
// never happened. The watch page says "Included in your subscription" instead.
// =============================================================================

import { api } from "@/lib/api-response";
import prisma from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const viewer = await getCurrentUser();
    if (!viewer) return api.privateSuccess({ videoIds: [] as string[] });

    const rows = await prisma.videoAccess.findMany({
      where: {
        viewerId: viewer.userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { videoId: true },
    });

    return api.privateSuccess({ videoIds: rows.map((row) => row.videoId) });
  } catch (error) {
    // A read that failed is a read that answers nothing — the client keeps
    // showing prices, which is the safe direction (see the hook).
    return api.internal((error as Error)?.message);
  }
}
