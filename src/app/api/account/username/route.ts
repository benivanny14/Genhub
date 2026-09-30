// =============================================================================
// GENHUB - Change username
// POST /api/account/username   { username }
//
// The handle is the one name nobody else may take, so changing it is its own
// endpoint rather than a field on PATCH /api/profile: the rules (format,
// reserved names, uniqueness) are enforced in one place, and a caller cannot
// smuggle a duplicate handle in beside an unrelated profile edit.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { usernameShapeSchema } from "@/lib/validation";
import { normalizeUsername, usernameFormatError } from "@/lib/usernames";
import { cacheDel } from "@/lib/redis";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = (await readJsonBody(request)) as { username?: unknown } | null;

    // Shape only, so a value that fails the *rules* below can still be compared
    // with what the account already has. Two statements, and the order matters:
    //
    //   "This is my username" is not a choice, so it is never judged by the
    //   rules for choosing one.
    //
    // That is what makes an account whose handle came out of the username
    // backfill usable. The migration numbers an email local part, so
    // `admin@…` holds `admin_1` — a handle the format rules would refuse as a
    // new choice, because it opens with a reserved word. Judging it before
    // comparing it would leave that account unable to save the profile form at
    // all, and the failure would read as "that username is reserved" beside a
    // field the person had not changed.
    const shape = usernameShapeSchema.safeParse(body?.username);
    if (!shape.success) {
      return api.validation(shape.error.errors[0].message);
    }
    const username = normalizeUsername(shape.data);

    const current = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { username: true },
    });

    if (!current) {
      return api.notFound("Account not found");
    }

    // Setting it to what it already is is not an error — just nothing to do.
    // Reported as success so a double submit is harmless.
    if (normalizeUsername(current.username ?? "") === username) {
      return api.success(
        { username: current.username },
        "That is already your username"
      );
    }

    // A name that is actually being changed is a new choice, and is held to the
    // rules for choosing one — the same ones the sign-up form applies.
    const formatError = usernameFormatError(username);
    if (formatError) {
      return api.validation(formatError);
    }

    // Checked here for the sentence; enforced again by the UNIQUE index, which
    // is what actually protects against two accounts racing for the same name.
    const taken = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (taken) {
      return api.error("That username is already taken — please choose another", 409);
    }

    const updated = await prisma.user.update({
      where: { id: auth.userId },
      data: { username },
      select: { id: true, username: true },
    });

    // The session payload and the header cache carry the old handle; drop them.
    await cacheDel(`user:${auth.userId}:*`);

    return api.success(updated, "Username updated");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    // A UNIQUE violation means the name was taken between the check and the
    // write; say the same thing the pre-check says rather than a 500.
    const prismaError = error as { code?: string; meta?: { target?: string[] | string } };
    const target = prismaError?.meta?.target;
    const targetsUsername =
      Array.isArray(target) ? target.includes("username") : target === "username";
    if (prismaError?.code === "P2002" && targetsUsername) {
      return api.error("That username is already taken — please choose another", 409);
    }
    console.error("[Change Username Error]", error);
    return api.internal();
  }
}
