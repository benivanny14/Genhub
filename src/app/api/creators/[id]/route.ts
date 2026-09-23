// =============================================================================
// GENHUB - Public Creator Profile API Route
// GET /api/creators/[id]
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";

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

    return api.success(creator);
  } catch (error) {
    console.error("[Creator Profile Error]", error);
    return api.internal();
  }
}
