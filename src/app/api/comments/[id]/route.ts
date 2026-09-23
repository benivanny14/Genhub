// =============================================================================
// GENHUB - Single Comment API Route
// DELETE /api/comments/[id] - Soft-delete own comment (or any, as admin)
// (Reporting lives at POST /api/comments/[id]/report)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();

    const comment = await prisma.comment.findUnique({
      where: { id: params.id },
      select: { id: true, userId: true, isDeleted: true },
    });

    if (!comment || comment.isDeleted) return api.notFound("Comment not found");
    if (comment.userId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden("You can only delete your own comments");
    }

    await prisma.comment.update({
      where: { id: params.id },
      data: { isDeleted: true },
    });

    return api.success(null, "Comment deleted");
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Delete Comment Error]", error);
    return api.internal();
  }
}
