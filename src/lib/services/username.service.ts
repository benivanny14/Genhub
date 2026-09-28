// =============================================================================
// GENHUB - Claiming a username
//
// The name a person chooses becomes their handle (see lib/usernames.ts), so
// there is no second name for them to invent and nothing to hand back to them
// when the handle is already taken. A collision is therefore resolved here, not
// reported: the derived handle is numbered until one is free.
//
// Numbering is not a promise of uniqueness — only the UNIQUE index is. Two
// sign-ups can pass this check at the same instant, and the loser gets a P2002
// from `create` (the register route retries with the next candidate). What this
// function buys is that the common case never surfaces as a database error at
// all, and that the number a person sees is the smallest free one.
// =============================================================================

import { randomBytes } from "crypto";
import prisma from "../db";
import { USERNAME_MAX_LENGTH, usernameAttempts } from "../usernames";

/** How many random tails to try before giving up on a base entirely. */
const RANDOM_ATTEMPTS = 5;

/**
 * `base` with a random tail, kept inside the length limit.
 *
 * The last resort, for a base whose numbered series (25 deep) is somehow all
 * taken. Random rather than longer numbers because a 26th sign-up with the same
 * name is a spam pattern, not a coincidence, and a random tail cannot be
 * guessed from the base alone.
 */
function randomHandle(base: string): string {
  const suffix = `_${randomBytes(3).toString("hex")}`;
  const room = USERNAME_MAX_LENGTH - suffix.length;
  const stem = base.slice(0, room).replace(/_+$/, "");
  return `${stem}${suffix}`;
}

/**
 * The first handle from `base` that no account holds, or null if even the
 * random tails are taken (in which case the caller has a database problem, not
 * a naming one).
 */
export async function freeUsername(base: string, attempts = 25): Promise<string | null> {
  const candidates = usernameAttempts(base, attempts);
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) candidates.push(randomHandle(base));

  for (const candidate of candidates) {
    const clash = await prisma.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }

  return null;
}
