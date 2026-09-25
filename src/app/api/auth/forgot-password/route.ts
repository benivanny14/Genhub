// =============================================================================
// GENHUB - Forgot Password API Route
// POST /api/auth/forgot-password - Generate and send password reset token
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { hashResetToken } from "@/lib/token-hash";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(`forgot:${ip}`, 5, 60_000);
    if (!allowed) return api.rateLimited("Too many attempts. Please wait a minute.");

    const { email, phone } = await request.json();

    if (!email && !phone) {
      return api.validation("An email address or phone number is required");
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
      select: { id: true },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      return api.success(null, "If that account exists, a reset message has been sent");
    }

    // Invalidate old tokens
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Generate token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Expires in 1 hour

    // Only the hash is stored — see lib/token-hash.ts. The token itself travels
    // in the email/SMS below and is never readable from the database again.
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        token: hashResetToken(token),
        expiresAt,
      },
    });

    // Send the reset link. sendMail never throws (console transport in dev,
    // SMTP in production) — the response stays identical either way so we
    // never leak whether an account exists.
    const { sendPasswordResetEmail } = await import("@/lib/email");
    const { default: config } = await import("@/lib/config");
    const resetUrl = `${config.appUrl.replace(/\/$/, "")}/reset-password?token=${token}`;
    const account = await prisma.user.findUnique({
      where: { id: user.id },
      select: { email: true, phone: true },
    });

    if (account?.email) {
      const result = await sendPasswordResetEmail(account.email, resetUrl);
      console.log(
        `[Password Reset] email user=${user.id} transport=${result.transport} sent=${result.sent}`
      );
    }
    if (account?.phone) {
      // Phone-only accounts recover over SMS (console transport in dev)
      const { sendPasswordResetSms } = await import("@/lib/sms");
      const sms = await sendPasswordResetSms(account.phone, resetUrl);
      console.log(
        `[Password Reset] sms user=${user.id} transport=${sms.transport} sent=${sms.sent}`
      );
    }
    if (!account?.email && !account?.phone) {
      // No contact point at all — log the token for support only
      console.log(`[Password Reset] token for user ${user.id}: ${token}`);
    }

    return api.success(null, "If that account exists, a reset message has been sent");
  } catch (error) {
    console.error("[Forgot Password Error]", error);
    return api.internal();
  }
}
