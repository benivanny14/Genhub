// =============================================================================
// GENHUB - Accept the creator guidelines
// POST /api/creator/guidelines/accept
//
// Called when a creator ticks the rules again after CREATOR_GUIDELINES_VERSION
// moved on. A creation-time receipt nobody re-checks is not consent, so the
// acceptance is (a) verified here on the server, where the creator cannot edit
// it, and (b) stored on the account, so it travels to every device instead of
// staying in one browser's localStorage.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { CREATOR_GUIDELINES_VERSION } from "@/lib/creator-guidelines";

export async function POST(_request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // The version is stamped from the server's own constant, not from the
    // request body: a client must not be able to claim it accepted a version
    // that does not exist, or one older than the text it was actually shown.
    const updated = await prisma.user.update({
      where: { id: auth.userId },
      data: {
        guidelinesAcceptedVersion: CREATOR_GUIDELINES_VERSION,
        guidelinesAcceptedAt: new Date(),
      },
      select: {
        guidelinesAcceptedVersion: true,
        guidelinesAcceptedAt: true,
      },
    });

    return api.success(updated, "Creator guidelines accepted");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Guideline Accept Error]", error);
    return api.internal();
  }
}
