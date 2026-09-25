// =============================================================================
// GENHUB - Who may watch a video
// =============================================================================
// One question, one answer, one place. It used to be answered in three
// different ways by three routes that all touch the same money:
//
//   GET  /api/videos/[id]            free, purchase, admin
//   GET  /api/videos/[id]/download   free, purchase, SUBSCRIPTION, admin
//   GET  /api/videos/[id]/stream     free, purchase, admin
//
// So a viewer who paid a monthly subscription to a creator was entitled to
// DOWNLOAD the file and not entitled to WATCH it: the feed that a subscription
// fills with videos led to a paywall, and the only way past it was to buy each
// scene separately — which is not what a subscription is. Nobody wrote that
// rule; it is what three copies of "check access" drifted into.
//
// SUBSCRIPTION IS AN ENTITLEMENT TO WATCH. A viewer with an active subscription
// to the creator sees the creator's scenes, including ones with a price on
// them, because that is what the monthly payment bought. The paywall says so in
// words ("Included in your subscription") instead of showing them a Buy button
// for something they are already paying for.
//
// `owner` is the creator of the row: they can always watch and download their
// own upload, most often from "View as viewer" before publishing.
//
// The self-heal is here too, for the same reason it existed in the video route:
// a SUCCESS charge with no access row (legacy rows, an interrupted credit) must
// never lock a paying customer out of what they bought.
// =============================================================================

import prisma from "@/lib/db";

export type EntitlementSource = "free" | "purchase" | "subscription" | "admin" | "owner";

export interface EntitlementVideo {
  /** The video ROW id — required, because access is keyed on it. */
  id: string;
  price: number;
  creatorId: string;
}

export interface EntitlementViewer {
  userId: string;
  role: string;
}

export interface Entitlement {
  entitled: boolean;
  source: EntitlementSource | null;
  /** True when a successful charge had no access row and one was created. */
  healed: boolean;
}

export async function resolveVideoEntitlement(
  video: EntitlementVideo,
  viewer: EntitlementViewer | null | undefined
): Promise<Entitlement> {
  // A free video has nothing to protect. Checked before the viewer so a
  // signed-out visitor can watch it too.
  if (video.price === 0) return { entitled: true, source: "free", healed: false };

  if (!viewer) return { entitled: false, source: null, healed: false };
  if (viewer.role === "ADMIN") return { entitled: true, source: "admin", healed: false };
  if (viewer.userId === video.creatorId) return { entitled: true, source: "owner", healed: false };

  const [access, purchase, subscription] = await Promise.all([
    prisma.videoAccess.findUnique({
      where: { viewerId_videoId: { viewerId: viewer.userId, videoId: video.id } },
      select: { id: true },
    }),
    prisma.transaction.findFirst({
      where: {
        userId: viewer.userId,
        videoId: video.id,
        type: "PPV_PURCHASE",
        status: "SUCCESS",
      },
      select: { id: true },
    }),
    prisma.creatorSubscription.findFirst({
      where: {
        viewerId: viewer.userId,
        creatorId: video.creatorId,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  ]);

  let healed = false;

  if (!access && purchase) {
    // Access is a fact, not a counter: only the first one creates a row.
    await prisma.videoAccess.upsert({
      where: { viewerId_videoId: { viewerId: viewer.userId, videoId: video.id } },
      create: { viewerId: viewer.userId, videoId: video.id },
      update: {},
    });
    healed = true;
  }

  if (access || purchase) return { entitled: true, source: "purchase", healed };
  if (subscription) return { entitled: true, source: "subscription", healed };

  return { entitled: false, source: null, healed: false };
}
