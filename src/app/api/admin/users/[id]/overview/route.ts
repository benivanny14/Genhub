// =============================================================================
// GENHUB - Admin \"View as user\"
//
// GET /api/admin/users/[id]/overview — everything an operator needs to answer
// \"what does this account actually see and own?\" in one read: profile, wallet,
// balances, recent money, memberships, unlocks, strikes and open reports.
//
// READ-ONLY, by construction: no branch here writes to the account it is
// looking at. Impersonating a user by minting a session for them is how support
// tooling becomes an account-takeover tool; looking at the same data the account
// itself can fetch gets the support answer without that power. The only write is
// the audit row that records the look.
// =============================================================================

import { requireRole, AuthError } from "@/lib/auth";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRole("ADMIN");
    const { id } = await params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        username: true,
        email: true,
        phone: true,
        role: true,
        isVerified: true,
        isBanned: true,
        banReason: true,
        freeAccess: true,
        kycStatus: true,
        strikes: true,
        walletBalance: true,
        messagesEnabled: true,
        payoutFrozenUntil: true,
        payoutFrozenReason: true,
        payoutMinimumWaived: true,
        locale: true,
        lastLoginAt: true,
        createdAt: true,
        creatorProfile: {
          select: { totalSubscribers: true, subscriptionPrice: true, bio: true },
        },
        creatorBalance: {
          select: {
            pendingBalance: true,
            availableBalance: true,
            totalEarned: true,
            releasedTotal: true,
          },
        },
        _count: {
          select: { videos: true, videoAccess: true, subscriptions: true },
        },
      },
    });

    if (!user) return api.notFound("User not found");

    // The last few things that moved, and the memberships and unlocks that
    // decide what the account can actually watch. Bounded, so opening a busy
    // account cannot become an expensive query.
    const [transactions, subscriptions, unlocks, strikes, openReports] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          amount: true,
          type: true,
          status: true,
          createdAt: true,
          video: { select: { title: true } },
        },
      }),
      prisma.creatorSubscription.findMany({
        where: { viewerId: id, isActive: true, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: "desc" },
        take: 20,
        select: {
          expiresAt: true,
          price: true,
          autoRenew: true,
          creator: { select: { id: true, displayName: true, username: true } },
        },
      }),
      prisma.videoAccess.findMany({
        where: { viewerId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          createdAt: true,
          expiresAt: true,
          video: { select: { id: true, title: true } },
        },
      }),
      prisma.strikeLog.findMany({
        where: { creatorId: id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { action: true, reason: true, createdAt: true, acknowledgedAt: true },
      }),
      prisma.videoReport.count({ where: { reporterId: id, status: "PENDING" } }),
    ]);

    // The look itself is the record. Written AFTER the read so a failed read
    // does not log a look nobody took.
    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.userViewAs,
      targetType: "User",
      targetId: id,
      summary: `Viewed the account of ${
        user.displayName || user.email || id
      } read-only`,
      detail: { readOnly: true },
    });

    return api.success({
      user,
      transactions,
      subscriptions,
      unlocks,
      strikes,
      openReports,
      readOnly: true,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin View As User Error]", error);
    return api.internal();
  }
}
