// =============================================================================
// GENHUB - Admin Comments API Route
// GET /api/admin/comments - List comments across every video
//
// Deleting a comment is not done here: it goes through the same
// DELETE /api/comments/[id] a user's own delete uses, which an admin is already
// allowed to call for ANY comment (see that route). One delete path means one
// place where the permission rule lives, and one place that writes the audit
// line when an admin removes somebody else's words.
//
// This route exists only so a moderator can SEE the conversation: which comment
// was posted, by whom, on which scene. Without it a comment can be reported and
// there is no way to read it without opening the video as a viewer.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const search = (request.nextUrl.searchParams.get("q") || "").trim();
    const videoId = (request.nextUrl.searchParams.get("videoId") || "").trim();
    // Deleted comments are hidden by default — a deleted comment answering a
    // search is confusing. The flag shows them for the case that matters:
    // checking that a removal actually took.
    const includeDeleted = request.nextUrl.searchParams.get("includeDeleted") === "1";

    const comments = await prisma.comment.findMany({
      where: {
        ...(includeDeleted ? {} : { isDeleted: false }),
        ...(videoId ? { videoId } : {}),
        ...(search
          ? {
              OR: [
                { body: { contains: search, mode: "insensitive" as const } },
                { user: { displayName: { contains: search, mode: "insensitive" as const } } },
                { user: { email: { contains: search, mode: "insensitive" as const } } },
                { video: { title: { contains: search, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 150,
      select: {
        id: true,
        body: true,
        isDeleted: true,
        parentId: true,
        createdAt: true,
        user: {
          select: { id: true, displayName: true, email: true, role: true, isBanned: true },
        },
        video: {
          select: { id: true, title: true, slug: true, thumbnailUrl: true },
        },
      },
    });

    const total = await prisma.comment.count({ where: { isDeleted: false } });

    return api.success({ comments, total });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin List Comments Error]", error);
    return api.internal();
  }
}
