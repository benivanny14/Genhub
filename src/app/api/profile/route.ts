// =============================================================================
// GENHUB - Profile Update API Route
// PATCH /api/profile - Update user profile or password
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { cacheDel, checkRateLimit } from "@/lib/redis";
import { mediaOrExternalUrl } from "@/lib/validation";
import { normalizeMediaUrl } from "@/lib/media";
import { normalizeUsername, usernameFormatError, usernameFromDisplayName } from "@/lib/usernames";
import { freeUsername } from "@/lib/services/username.service";
import config from "@/lib/config";

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Profile edits and password changes are per account. The password path in
    // particular runs a deliberate bcrypt compare, so a loop here is CPU the
    // whole deployment pays for — 30 a minute is far above a person editing a
    // profile and well below a script.
    const { allowed } = await checkRateLimit(`profile:${auth.userId}`, 30, 60_000);
    if (!allowed) return api.rateLimited("Too many updates — please wait a moment");

    const body = await readJsonBody(request);

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

    // The name used to be copied out of the body unexamined, so a number or an
    // object was handed to a String column (a 500 the person cannot act on) and
    // a 10,000-character name was stored and then rendered in the header, on
    // cards and inside JSON-LD. Same rule as sign-up: 2-50 characters after
    // trimming. Null or "" still clears it, which is what the form sends when
    // the field is emptied.
    if (body.displayName !== undefined) {
      if (body.displayName === null || body.displayName === "") {
        updates.displayName = null;
      } else if (typeof body.displayName !== "string") {
        return api.validation("Name must be text");
      } else {
        const name = body.displayName.trim();
        if (name.length < 2 || name.length > 50) {
          return api.validation("Name must be between 2 and 50 characters");
        }
        updates.displayName = name;
      }
    }

    // ------------------------------------------------------- Name = username
    //
    // Saving a name also claims the handle made from it, so the public name and
    // the @username are one thing and cannot drift apart — change your name,
    // change your handle. A handle somebody else holds is numbered
    // (`amani_2`), never refused: it is the name the person chose.
    //
    // Two cases deliberately leave the handle alone, and neither is an error:
    //   * the name folds to the handle the account already has — there is
    //     nothing to write;
    //   * the handle it folds to is one the rules refuse (a name that opens with
    //     a reserved word, or folds to under three characters). Renaming an
    //     account to `admin` is not on the table, and refusing to save a NAME
    //     because of a HANDLE rule would be a refusal with no way forward — the
    //     name is saved and the existing handle stands.
    if (typeof updates.displayName === "string") {
      const desired = usernameFromDisplayName(updates.displayName);
      if (desired) {
        const current = await prisma.user.findUnique({
          where: { id: auth.userId },
          select: { username: true },
        });
        const held = normalizeUsername(current?.username ?? "");
        if (held !== desired && !usernameFormatError(desired)) {
          const free = await freeUsername(desired);
          if (free && free !== current?.username) updates.username = free;
        }
      }
    }

    // Only the two languages the interface actually ships. A free string here is
    // stored in the account and read back by the app on every device, so a typo
    // (“swh”, “EN”) used to leave that account permanently on the fallback
    // language with nothing to explain why the switch did nothing.
    if (body.locale !== undefined) {
      if (body.locale !== "sw" && body.locale !== "en") {
        return api.validation('Language must be "sw" or "en"');
      }
      updates.locale = body.locale;
    }
    // The weekly earnings digest is opt-out, so this only ever turns it off (or
    // back on). Coerced to a boolean so a stray string cannot silently disable
    // the one email that summarises their week on the platform.
    if (body.earningsDigestEnabled !== undefined) {
      if (typeof body.earningsDigestEnabled !== "boolean") {
        return api.validation("earningsDigestEnabled must be true or false");
      }
      updates.earningsDigestEnabled = body.earningsDigestEnabled;
    }
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
        // Returned so the profile can show the handle the name just claimed.
        username: true,
        locale: true,
        avatarUrl: true,
        earningsDigestEnabled: true,
      },
    });

    await cacheDel(`user:${auth.userId}:*`);

    return api.success(updated, "Profile updated");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Profile Update Error]", error);
    return api.internal();
  }
}
