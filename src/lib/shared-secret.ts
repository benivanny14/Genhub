// =============================================================================
// GENHUB - Constant-time comparison for shared secrets
//
// Two callers need the same property, and only one of them had it:
// src/lib/cron-auth.ts hashed both sides and compared with timingSafeEqual,
// while the HarakaPay webhook compared with `!==`. `!==` on a secret stops at
// the first differing character, so it leaks how many leading characters were
// correct — which is how a guess gets narrowed down. The fix for one is the fix
// for both, so the rule lives in one place and neither caller can drift.
// =============================================================================

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the buffers are always the same length:
 * timingSafeEqual throws on unequal lengths, and that throw itself would leak
 * the secret's length.
 *
 * An empty side never matches, including another empty side. That looks
 * pedantic until you consider the caller who forgets its own "is a secret
 * configured?" branch: without this, a missing secret and a missing parameter
 * would compare equal and every unauthenticated request would pass. Callers
 * still check for a missing secret themselves — they have to, because the
 * answer is different in production — but this cannot be the thing that lets it
 * through.
 */
export function secretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;

  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
