// =============================================================================
// GENHUB - Forgot Password API Route
// POST /api/auth/forgot-password - Email a password reset link
//
// EMAIL ONLY. The request takes an email address and nothing else, and the link
// is delivered by email — the SMS branch this route used to have is gone, along
// with phone-based sign-up that made it necessary. See
// lib/services/password-reset.service.ts for why, and for where the token is
// issued (the admin panel issues the same link through the same function).
//
// The response never varies: same message whether the account exists, has no
// email on file, or never existed. Anything else turns this endpoint into an
// oracle for "does this address have a Genhub account?".
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { sendPasswordResetLink } from "@/lib/services/password-reset.service";
import { emailMatch } from "@/lib/validation";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(`forgot:${ip}`, 5, 60_000);
    if (!allowed) return api.rateLimited("Too many attempts. Please wait a minute.");

    const { email } = await request.json().catch(() => ({}));

    if (typeof email !== "string" || !EMAIL.test(email.trim())) {
      return api.validation("Enter the email address on your account");
    }

    // Case-insensitive: the account's row may hold the address with capitals
    // from before it was normalised, and an exact match would silently answer
    // "if that account exists…" while sending nothing at all.
    const user = await prisma.user.findFirst({
      where: emailMatch(email),
      select: { id: true },
    });

    // Always success, whether the address is registered or not.
    if (!user) {
      return api.success(null, "If that account exists, a reset link has been emailed");
    }

    // Delivery is the service's problem, and it fails softly: an account with no
    // email on file is logged for support and reported to nobody, because
    // reporting it would confirm the account exists.
    await sendPasswordResetLink(user.id);

    return api.success(null, "If that account exists, a reset link has been emailed");
  } catch (error) {
    console.error("[Forgot Password Error]", error);
    return api.internal();
  }
}
