// =============================================================================
// GENHUB - Profile Update API Route
// PATCH /api/profile - Update user profile or password
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { cacheDel } from "@/lib/redis";
import { mediaOrExternalUrl } from "@/lib/validation";
import { normalizeMediaUrl } from "@/lib/media";
import config from "@/lib/config";

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth();
    const body = await request.json();

    // Password change flow
    if (body.currentPassword && body.newPassword) {
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { passwordHash: true },
      });

      if (!user) return api.notFound();

      const isValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!isValid) return api.error("Your current password is incorrect", 401);

      if (body.newPassword.length < 8) {
        return api.validation("Your new password must be at least 8 characters");
      }

      const newHash = await bcrypt.hash(body.newPassword, 12);
      await prisma.user.update({
        where: { id: auth.userId },
        data: { passwordHash: newHash },
      });

      return api.success(null, "Password changed");
    }

    // Profile update flow
    const updates: Record<string, unknown> = {};
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.locale !== undefined) updates.locale = body.locale;
    if (body.avatarUrl !== undefined) {
      // `avatarUrl: string` was taken straight from the request body, so any
      // string at all could be stored and then rendered as an <img src>. An
      // empty value clears the picture; anything else must be one of our media
      // paths or a real external URL.
      if (body.avatarUrl === null || body.avatarUrl === "") {
        updates.avatarUrl = null;
      } else {
        const parsed = mediaOrExternalUrl("avatar URL").safeParse(body.avatarUrl);
        if (!parsed.success) {
          return api.validation(parsed.error.errors[0].message);
        }
        updates.avatarUrl = normalizeMediaUrl(parsed.data, config.bunny.cdnHostname);
      }
    }

    if (Object.keys(updates).length === 0) {
      return api.validation("Nothing to update");
    }

    const updated = await prisma.user.update({
      where: { id: auth.userId },
      data: updates,
      select: {
        id: true,
        displayName: true,
        locale: true,
        avatarUrl: true,
      },
    });

    await cacheDel(`user:${auth.userId}:*`);

    return api.success(updated, "Wasifu umesasishwa");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Profile Update Error]", error);
    return api.internal();
  }
}
