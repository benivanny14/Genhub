// =============================================================================
// GENHUB - Register API Route
// POST /api/auth/register
//
// One name is asked for, and it is the name the person answers with: the text
// they type is stored as `displayName` and folded into their unique `@username`.
// There is no second field for a handle, because a second field is a second
// name — and the public name is meant to be the username.
// =============================================================================

import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";
import { generateToken, setAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { registerSchema, emailMatch } from "@/lib/validation";
import { checkRateLimitStrict } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";
import { CREATOR_GUIDELINES_VERSION } from "@/lib/creator-guidelines";
import {
  isReservedUsername,
  usernameFormatError,
  usernameFromDisplayName,
} from "@/lib/usernames";
import { freeUsername } from "@/lib/services/username.service";

/** True when a Prisma error is the UNIQUE index on `username` refusing a write. */
function isUsernameRace(error: unknown): boolean {
  const prismaError = error as { code?: string; meta?: { target?: string[] | string } };
  const target = prismaError?.meta?.target;
  const targetsUsername =
    Array.isArray(target) ? target.includes("username") : target === "username";
  return prismaError?.code === "P2002" && targetsUsername;
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip = clientIp(request.headers);
    // Registration creates rows and sends mail; on a shared-store outage it
    // fails closed rather than letting one instance's memory be the only bound.
    const rl = await checkRateLimitStrict(
      `register:${ip}`,
      config.rateLimit.auth.max,
      config.rateLimit.auth.windowMs
    );
    if (rl.unavailable) {
      return api.error(
        "Sign-up is temporarily unavailable. Please try again in a moment.",
        503,
        "TEMPORARILY_UNAVAILABLE"
      );
    }
    if (!rl.allowed) {
      return api.rateLimited("Too many attempts. Please wait a few minutes.");
    }

    // Parse and validate body
    const body = await readJsonBody(request);
    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { displayName, email, password, role, locale, referralCode } = result.data;

    // ------------------------------------------------------------ The one name
    //
    // The name a person types IS their username. A form that sends no handle
    // gets one made from the name it did send (`Kayena glazed` -> `@kayena_glazed`),
    // and a handle that somebody already holds is NUMBERED rather than refused
    // (`@kayena_glazed_2`): the person already told us which name they want, so
    // "that name is taken" would be an answer to a question they were never
    // asked. Renaming them is not an option either — it is their name.
    //
    // A handle sent explicitly is still honoured, because that is a choice: a
    // collision there is reported (409) instead of quietly numbered behind the
    // caller's back.
    const choseHandle = result.data.username !== undefined && result.data.username !== null;
    let handle = choseHandle ? result.data.username! : usernameFromDisplayName(displayName);

    if (!handle) {
      // Nothing in the name survives being put in a URL or quoted in a reply:
      // an emoji, punctuation, a script the folding cannot read. The rule is
      // stated where the name is typed rather than guessed around.
      return api.validation(
        "Add a letter or a number to your name — that is what becomes your @username"
      );
    }

    if (!choseHandle) {
      const problem = usernameFormatError(handle);
      if (problem) {
        return api.validation(
          isReservedUsername(handle)
            ? `Your name would claim the reserved username @${handle} — add a surname or a number to your name`
            : `Your name gives the username @${handle}. ${problem}`
        );
      }
      const free = await freeUsername(handle);
      if (!free) {
        console.error("[Register] No free username for base", handle);
        return api.internal("Something went wrong during sign-up");
      }
      handle = free;
    }

    // Resolve referrer (affiliate attribution) before creating the user
    let referrer: { id: string; displayName: string | null } | null = null;
    if (referralCode) {
      referrer = await prisma.user.findUnique({
        where: { referralCode: referralCode.toUpperCase() },
        select: { id: true, displayName: true },
      });
    }

    // Email is the only identifier a new account can have — see registerSchema.
    //
    // Matched case-insensitively, not by the unique column alone: `email` is
    // stored lowercase now (registerSchema), but rows created before that rule
    // still hold their original capitals, and an exact lookup would let the very
    // same address sign up a second time beside them.
    const existingUser = await prisma.user.findFirst({
      where: emailMatch(email),
      select: { id: true },
    });

    if (existingUser) {
      return api.error("This email address is already in use", 409);
    }

    // Only a handle the caller NAMED can be reported as taken; a derived one was
    // resolved to something free a few lines up.
    if (choseHandle) {
      const existingUsername = await prisma.user.findUnique({
        where: { username: handle },
        select: { id: true },
      });

      if (existingUsername) {
        return api.error("That username is already taken — please choose another", 409);
      }
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

    // Everything but the handle, so the insert below can be attempted twice with
    // two different handles without recomputing (or re-hashing) any of it.
    const account = {
      displayName,
      email,
      passwordHash,
      role,
      locale,
      referralCode: myReferralCode,
      referredById: referrer?.id,
      // A creator cannot reach the sign-up form without ticking every rule, so
      // the account is born with the current version accepted. Recorded
      // server-side so it holds on every device, and so the upload screen can
      // tell whether the rules have moved on since.
      ...(role === "CREATOR"
        ? {
            creatorBalance: { create: {} },
            guidelinesAcceptedVersion: CREATOR_GUIDELINES_VERSION,
            guidelinesAcceptedAt: new Date(),
          }
        : {}),
    };

    const select = {
      id: true,
      displayName: true,
      username: true,
      email: true,
      phone: true,
      role: true,
      locale: true,
      createdAt: true,
    } as const;

    let user;
    try {
      user = await prisma.user.create({ data: { ...account, username: handle }, select });
    } catch (race) {
      // Two people with the same name can sign up in the same instant. The
      // UNIQUE index is the real guard and one of them loses the race; the loser
      // is given the next number rather than a refusal, because "choose another
      // username" points at a field this form does not have.
      if (choseHandle || !isUsernameRace(race)) throw race;
      const next = await freeUsername(usernameFromDisplayName(displayName) || handle);
      if (!next) throw race;
      console.warn(`[Register] Handle race on ${handle} — using ${next}`);
      user = await prisma.user.create({ data: { ...account, username: next }, select });
    }

    // ------------------------------------------------------- The referral bonus
    //
    // Sign-up credits the referrer NOTHING. It used to pay TZS 1,000 the moment
    // the account existed, which is free money for anyone who can type an email
    // address: create ten addresses, collect TZS 10,000, spend it on videos and
    // tips, and the balance becomes a creator's earnings and then a real payout.
    // No purchase was ever needed, so the platform was paying out of nothing.
    //
    // The reward now rides on the invited person's FIRST real payment, settled in
    // processPaymentWebhook — the one place gateway money lands (see
    // services/referral.service.ts). What is recorded here, `referredById`, is
    // the attribution that bonus is released against.

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
    // The UNIQUE index is the real guard, and this turns its error into the same
    // sentence the pre-checks give instead of an opaque 500.
    if (isUsernameRace(error)) {
      return api.error("That username is already taken — please choose another", 409);
    }
    console.error("[Register Error]", error);
    return api.internal("Something went wrong during sign-up");
  }
}
