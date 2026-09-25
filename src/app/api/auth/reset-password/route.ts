// =============================================================================
// GENHUB - Reset Password API Route
// POST /api/auth/reset-password - Verify token and set new password
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { hashResetToken } from "@/lib/token-hash";
import { z } from "zod";

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(`reset:${ip}`, 5, 60_000);
    if (!allowed) return api.rateLimited("Too many attempts");

    const body = await request.json();
    const result = resetSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { token, password } = result.data;

    // Find valid token. The row holds the hash, so the presented token is hashed
    // before the lookup — see lib/token-hash.ts for why the database gets the
    // hash and the customer gets the token.
    const resetRecord = await prisma.passwordReset.findUnique({
      where: { token: hashResetToken(token) },
    });

    if (!resetRecord || resetRecord.used || resetRecord.expiresAt < new Date()) {
      return api.error("This token is invalid or has expired");
    }

    // Hash new password and update
    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: resetRecord.userId },
        data: { passwordHash },
      });

      await tx.passwordReset.update({
        where: { id: resetRecord.id },
        data: { used: true },
      });
    });

    return api.success(null, "Password changed. Sign in with your new password.");
  } catch (error) {
    console.error("[Reset Password Error]", error);
    return api.internal();
  }
}
