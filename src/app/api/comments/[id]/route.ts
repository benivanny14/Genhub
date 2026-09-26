// =============================================================================
// GENHUB - Single Comment API Route
// DELETE /api/comments/[id] - Soft-delete own comment (or any, as admin)
// (Reporting lives at POST /api/comments/[id]/report)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();

    const comment = await prisma.comment.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        userId: true,
        isDeleted: true,
        body: true,
        videoId: true,
        user: { select: { displayName: true, email: true } },
        video: { select: { title: true } },
      },
    });

    if (!comment || comment.isDeleted) return api.notFound("Comment not found");
    if (comment.userId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden("You can only delete your own comments");
    }

    await prisma.comment.update({
      where: { id: params.id },
      data: { isDeleted: true },
    });

    // An admin removing somebody else's words is a moderation act, so it is
    // recorded with the text that was removed — a log line saying "deleted a
    // comment" cannot answer the only question that follows: what did it say?
    // A user deleting their own comment records nothing; that is not a decision
    // about another person.
    if (auth.role === "ADMIN" && comment.userId !== auth.userId) {
      await recordAudit({
        actorId: auth.userId,
        action: AUDIT_ACTIONS.commentDelete,
        targetType: "Comment",
        targetId: comment.id,
        summary: `Deleted a comment by ${comment.user.displayName || comment.user.email || comment.userId} on "${comment.video.title}"`,
        detail: {
          videoId: comment.videoId,
          videoTitle: comment.video.title,
          authorId: comment.userId,
          body: comment.body.slice(0, 500),
        },
      });
    }

    return api.success(null, "Comment deleted");
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Delete Comment Error]", error);
    return api.internal();
  }
}
