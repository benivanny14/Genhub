// =============================================================================
// GENHUB - Account
// DELETE /api/account - erase the signed-in user's account and everything in it
//
// Three gates, because this is the only irreversible action in the product:
//
//   1. The password. A session cookie is not enough on its own — the whole point
//      of asking again is that a borrowed or stolen session must not be able to
//      destroy an account (and, for a creator, delete a catalogue of paid videos).
//   2. The word DELETE, typed. Confirmation dialogs get clicked through; typing
//      is deliberate.
//   3. The last-admin rule (see account-erasure.service.ts) — refusing when this
//      is the only admin, because the site would be left with nobody able to
//      approve creators or reach /admin.
//
// What happens next is in the service: remote media first, then every row in one
// transaction. The response is the receipt, including anything that could not be
// removed.
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { requireAuth, removeAuthCookie, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { canEraseAccount, eraseAccount } from "@/lib/services/account-erasure.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIRMATION = "DELETE";

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Cheap guard against somebody hammering the password check with a script.
    const { allowed } = await checkRateLimit(`erase:${auth.userId}`, 5, 60_000);
    if (!allowed) {
      return api.rateLimited("Too many attempts — wait a minute and try again.");
    }

    const body = (await request.json().catch(() => null)) as
      | { password?: string; confirm?: string }
      | null;

    if (!body?.password) {
      return api.validation("Enter your password to confirm");
    }
    if ((body.confirm || "").trim().toUpperCase() !== CONFIRMATION) {
      return api.validation(`Type ${CONFIRMATION} to confirm`);
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { passwordHash: true, role: true },
    });
    if (!user) return api.notFound();

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return api.error("That password is not correct", 401, "BAD_PASSWORD");
    }

    const verdict = await canEraseAccount(auth.userId, user.role);
    if (!verdict.allowed) {
      return api.error(verdict.reason || "This account cannot be deleted", 409, "REFUSED");
    }

    const report = await eraseAccount(auth.userId);

    // The account is gone; the cookie must be too, or every later request would
    // carry a token for a user id that no longer exists.
    await removeAuthCookie();

    return api.success(report, "Your account has been deleted");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Account Erasure Error]", error);
    return api.internal();
  }
}
