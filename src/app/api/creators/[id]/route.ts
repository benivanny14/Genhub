// =============================================================================
// GENHUB - Public Creator Profile API Route
// GET /api/creators/[id]
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import {
  blueTickIsLive,
  reconcileUserBlueTick,
} from "@/lib/services/blue-tick.service";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;

    const creator = await prisma.user.findUnique({
      where: { id, role: "CREATOR", isBanned: false },
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        isVerified: true,
        verifiedUntil: true,
        createdAt: true,
        creatorProfile: true,
        _count: {
          select: {
            videos: { where: { isPublished: true, isDeleted: false } },
          },
        },
      },
    });

    if (!creator) return api.notFound("This creator does not exist");

    // The blue tick is bought by the month, so `isVerified` alone is not the
    // answer to "does this profile show a badge": it also has an expiry. The
    // check is derived (blueTickIsLive) AND tidied here, because a profile view
    // is exactly where a lapsed month must not still be showing.
    if (creator.isVerified && !blueTickIsLive(creator)) {
      await reconcileUserBlueTick(id);
    }

    const { verifiedUntil: _expiry, ...publicCreator } = creator;
    return api.success({ ...publicCreator, isVerified: blueTickIsLive(creator) });
  } catch (error) {
    console.error("[Creator Profile Error]", error);
    return api.internal();
  }
}
