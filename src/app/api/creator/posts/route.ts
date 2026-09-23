// =============================================================================
// GENHUB - Creator Status Posts API Route
// POST /api/creator/posts - Publish a timeline post (creator only)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { creatorPostSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const body = await request.json();
    const result = creatorPostSchema.safeParse(body);
    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const post = await prisma.creatorPost.create({
      data: {
        creatorId: auth.userId,
        body: result.data.body,
        imageUrl: result.data.imageUrl,
      },
      include: {
        creator: {
          select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
        },
      },
    });

    return api.success(post, "Post published", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Creator Post Error]", error);
    return api.internal();
  }
}
