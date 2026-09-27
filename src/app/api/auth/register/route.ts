// =============================================================================
// GENHUB - Register API Route
// POST /api/auth/register
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { generateToken, setAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { registerSchema } from "@/lib/validation";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";
import { CREATOR_GUIDELINES_VERSION } from "@/lib/creator-guidelines";

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip = clientIp(request.headers);
    const { allowed, remaining } = await checkRateLimit(
      `register:${ip}`,
      config.rateLimit.auth.max,
      config.rateLimit.auth.windowMs
    );

    if (!allowed) {
      return api.rateLimited("Too many attempts. Please wait a few minutes.");
    }

    // Parse and validate body
    const body = await request.json();
    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { displayName, email, password, role, locale, referralCode } = result.data;

    // Resolve referrer (affiliate attribution) before creating the user
    let referrer: { id: string; displayName: string | null } | null = null;
    if (referralCode) {
      referrer = await prisma.user.findUnique({
        where: { referralCode: referralCode.toUpperCase() },
        select: { id: true, displayName: true },
      });
    }

    // Email is the only identifier a new account can have — see registerSchema.
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return api.error("This email address is already in use", 409);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Unique referral code for the new user
    let myReferralCode: string | undefined;
    {
      const base = (displayName || "GEN")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = `${base || "GEN"}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`;
        const clash = await prisma.user.findUnique({
          where: { referralCode: candidate },
          select: { id: true },
        });
        if (!clash) {
          myReferralCode = candidate;
          break;
        }
      }
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        displayName,
        email,
        passwordHash,
        role,
        locale,
        referralCode: myReferralCode,
        referredById: referrer?.id,
        // A creator cannot reach the sign-up form without ticking every rule,
        // so the account is born with the current version accepted. Recorded
        // server-side so it holds on every device, and so the upload screen can
        // tell whether the rules have moved on since.
        ...(role === "CREATOR"
          ? {
              creatorBalance: { create: {} },
              guidelinesAcceptedVersion: CREATOR_GUIDELINES_VERSION,
              guidelinesAcceptedAt: new Date(),
            }
          : {}),
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        phone: true,
        role: true,
        locale: true,
        createdAt: true,
      },
    });

    // Referral reward: TZS 1,000 to the referrer, credited immediately
    if (referrer) {
      const REFERRAL_REWARD = 1000;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: referrer.id },
            data: {
              walletBalance: { increment: REFERRAL_REWARD },
              referralEarnings: { increment: REFERRAL_REWARD },
            },
          });
          await tx.transaction.create({
            data: {
              userId: referrer.id,
              amount: REFERRAL_REWARD,
              type: "REFERRAL_BONUS",
              status: "SUCCESS",
            },
          });
          await tx.notification.create({
            data: {
              userId: referrer.id,
              title: "Referral bonus! 🎉",
              message: `${displayName} joined Genhub with your code — TZS ${REFERRAL_REWARD.toLocaleString()} added to your wallet.`,
              type: "success",
              link: "/wallet",
            },
          });
        });
      } catch (rewardError) {
        // Reward failure must never block signup
        console.error("[Referral Reward Error]", rewardError);
      }
    }

    // Generate JWT and set cookie
    const token = await generateToken({
      userId: user.id,
      email: user.email ?? undefined,
      phone: user.phone ?? undefined,
      role: user.role,
    });
    await setAuthCookie(token);

    // Welcome email — fire-and-forget, never blocks signup
    // (console transport in dev / when SMTP is not configured)
    if (user.email) {
      import("@/lib/email")
        .then(({ sendWelcomeEmail }) =>
          sendWelcomeEmail(user.email!, user.displayName || "")
        )
        .catch((mailError) =>
          console.error("[Welcome Email Error]", mailError)
        );
    }
    return api.success(user, "Sign-up successful", 201);
  } catch (error) {
    console.error("[Register Error]", error);
    return api.internal("Something went wrong during sign-up");
  }
}
