// =============================================================================
// GENHUB - Become a Creator API Route
// POST /api/account/become-creator - Upgrades a signed-in VIEWER to CREATOR.
// Creates the creator balance record, re-issues the JWT (role lives inside the
// token, so the cookie must be refreshed), and sends a welcome notification.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError, generateToken, setAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    if (auth.role === "CREATOR") {
      return api.success({ role: "CREATOR", already: true }, "You are already a creator");
    }
    if (auth.role === "ADMIN") {
      // Admins already have full access — no role change needed
      return api.success({ role: "ADMIN", already: true }, "Admin accounts do not need upgrading");
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, email: true, phone: true, role: true, isBanned: true, strikes: true },
    });

    if (!user) return api.notFound("This user no longer exists");
    if (user.isBanned) return api.forbidden("Your account has been suspended");
    if (user.strikes >= 3) return api.forbidden("Your account has reached three strikes");

    // Upgrade role + ensure a balance record exists (atomic)
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { role: "CREATOR" },
      }),
      prisma.creatorBalance.upsert({
        where: { creatorId: user.id },
        create: { creatorId: user.id, pendingBalance: 0, availableBalance: 0, totalEarned: 0 },
        update: {},
      }),
    ]);

    // Welcome notification pointing at the next step (KYC)
    await prisma.notification.create({
      data: {
        userId: user.id,
        title: "Welcome to the creators' side! 🎬",
        message:
          "Your account is now a Creator account. Verify your identity (KYC) to unlock uploads and payouts.",
        type: "success",
        link: "/creator/kyc",
      },
    });

    // Role lives inside the JWT — re-issue so middleware and requireRole see CREATOR
    const token = await generateToken({
      userId: user.id,
      email: user.email ?? undefined,
      phone: user.phone ?? undefined,
      role: "CREATOR",
    });
    await setAuthCookie(token);

    return api.success({ role: "CREATOR", kycRequired: true }, "Welcome aboard! Verify your identity to start uploading.");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Become Creator Error]", error);
    return api.internal();
  }
}
