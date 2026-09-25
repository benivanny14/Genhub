// =============================================================================
// GENHUB - Is this account still allowed to do anything?
//
// A session token is a statement about the past: "this person proved who they
// were, at most seven days ago". Everything the app did with it treated it as a
// statement about the present, which is why a banned account kept working. Bans
// are issued by an admin, who reasonably expects the ban to take effect — the
// only thing that stopped a banned user was signing in again, and if they had a
// token in their browser they never had to.
//
// The measured consequence before this file existed: a banned account could
// still buy videos, send tips, request a payout, submit KYC, upload thumbnails,
// post comments and write posts, for up to seven days, across 31 write routes.
//
// -----------------------------------------------------------------------------
// Where the check runs, and why not in the database session itself
// -----------------------------------------------------------------------------
// The two guards every route already funnels through are `requireAuth` and
// `requireRole`, so the rule lives there — one place, and a new route cannot
// forget it. `requireRole` calls `requireAuth`, so this is one insertion point
// rather than thirty-one.
//
// -----------------------------------------------------------------------------
// Cache, and which way it fails
// -----------------------------------------------------------------------------
// One indexed primary-key lookup per authenticated request would be honest and
// expensive, so the answer is remembered for a minute. A minute of a banned user
// still browsing is a far smaller harm than a database round trip on every
// request, and `invalidateAccountStatus` lets the admin action clear it outright
// so the common case (an admin bans somebody and checks) is immediate.
//
// A database error returns "allowed". That direction is deliberate: a blip must
// not sign out every user on the platform. The failure mode is a banned account
// getting through during an outage, which is recoverable; the alternative is
// everyone locked out of a site that is otherwise fine.
//
// A missing user, by contrast, is NOT an outage and is enforced immediately: the
// account was erased (see account-erasure.service.ts), and a token naming a user
// that no longer exists must stop working at once — otherwise the deletion
// leaves a live credential behind for the rest of its seven days.
// =============================================================================

import prisma from "../db";

/** How long a verdict is reused. See the header: one minute, on purpose. */
export const ACCOUNT_STATUS_TTL_MS = 60_000;

export interface AccountStatus {
  /** The user row still exists. */
  exists: boolean;
  /** The row exists and is flagged as banned. */
  banned: boolean;
}

interface CacheEntry {
  status: AccountStatus;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Bound the map so a long-lived process cannot grow it without limit. */
const MAX_ENTRIES = 5_000;

/**
 * Whether this user id may act, and whether the account still exists.
 *
 * Never throws: see the header for why an outage reads as "allowed".
 */
export async function accountStatusFor(userId: string): Promise<AccountStatus> {
  const cached = cache.get(userId);
  const now = Date.now();
  if (cached && now - cached.at < ACCOUNT_STATUS_TTL_MS) {
    return cached.status;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isBanned: true },
    });

    const status: AccountStatus = user
      ? { exists: true, banned: user.isBanned }
      : { exists: false, banned: false };

    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(userId, { status, at: now });
    return status;
  } catch {
    // Fail open — an outage is not a ban. Not cached, so it is retried on the
    // next request rather than being remembered as a healthy account.
    return { exists: true, banned: false };
  }
}

/**
 * Forget a verdict, so the next request asks the database again.
 *
 * Called by the admin actions that change `isBanned`, which is the case where
 * the stale minute would be most visible (the admin bans somebody and then
 * looks at the account).
 */
export function invalidateAccountStatus(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Tests need a clean slate between cases. */
export function resetAccountStatusCache(): void {
  cache.clear();
}
