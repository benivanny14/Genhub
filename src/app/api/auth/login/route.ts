// =============================================================================
// GENHUB - Login API Route
// POST /api/auth/login
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { generateToken, setAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { loginSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(
      `login:${ip}`,
      config.rateLimit.auth.max,
      config.rateLimit.auth.windowMs
    );

    if (!allowed) {
      return api.rateLimited("Too many attempts. Please wait a few minutes.");
    }

    const body = await request.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { email, phone, password } = result.data;

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (!user) {
      return api.error("Incorrect sign-in details", 401);
    }

    // Check banned
    if (user.isBanned) {
      return api.error(
        "Your account has been suspended. Contact support.",
        403
      );
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return api.error("Incorrect sign-in details", 401);
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT
    const token = await generateToken({
      userId: user.id,
      email: user.email ?? undefined,
      phone: user.phone ?? undefined,
      role: user.role,
    });
    await setAuthCookie(token);

    // Return user data (no password hash)
    const { passwordHash: _, ...safeUser } = user;
    return api.success(safeUser, "Umeingia kikamilifu");
  } catch (error) {
    console.error("[Login Error]", error);
    return api.internal("Something went wrong while signing in");
  }
}
