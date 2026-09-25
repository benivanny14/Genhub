// =============================================================================
// GENHUB - Admin Users API Route
// GET /api/admin/users - List users (creators by default)
// POST /api/admin/users - Verify/unverify, ban/unban a user
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { invalidateAccountStatus } from "@/lib/services/account-status.service";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const role = request.nextUrl.searchParams.get("role") || "CREATOR";
    const search = request.nextUrl.searchParams.get("q") || "";

    const users = await prisma.user.findMany({
      where: {
        ...(role ? { role: role as "VIEWER" | "CREATOR" | "ADMIN" } : {}),
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: "insensitive" as const } },
                { email: { contains: search, mode: "insensitive" as const } },
                { phone: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        displayName: true,
        email: true,
        phone: true,
        role: true,
        isVerified: true,
        isBanned: true,
        banReason: true,
        kycStatus: true,
        strikes: true,
        walletBalance: true,
        createdAt: true,
        _count: {
          select: {
            videos: { where: { isPublished: true, isDeleted: false } },
          },
          },
      },
    });

    return api.success({ users });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin List Users Error]", error);
    return api.internal();
  }
}

const ACTIONS = ["VERIFY", "UNVERIFY", "BAN", "UNBAN"] as const;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const userId = body?.userId?.toString();
    const action = body?.action as (typeof ACTIONS)[number];

    if (!userId) return api.validation("userId is required");
    if (!ACTIONS.includes(action)) return api.validation("Invalid action");

    const target = await prisma.user.findUnique({
      where: { id: userId },
      // displayName/email are here for the audit line: "Banned Ivanny" is worth
      // reading, "Banned cmug2mvrs…" is a lookup, and the person reading the log
      // is usually in a hurry.
      select: {
        id: true,
        role: true,
        isVerified: true,
        isBanned: true,
        displayName: true,
        email: true,
      },
    });
    if (!target) return api.notFound("User not found");
    if (target.id === auth.userId && (action === "BAN" || action === "UNVERIFY")) {
      return api.validation("You cannot apply this action to your own account");
    }

    if (action === "VERIFY" || action === "UNVERIFY") {
      const isVerified = action === "VERIFY";
      await prisma.user.update({
        where: { id: userId },
        data: { isVerified },
      });
      await prisma.notification.create({
        data: {
          userId,
          title: isVerified ? "You are verified! 🎉" : "Verification removed",
          message: isVerified
            ? "Your account now displays the verified badge."
            : "The verified badge was removed from your account.",
          type: isVerified ? "success" : "warning",
          link: "/profile",
        },
      });
      await recordAudit({
        actorId: auth.userId,
        action: isVerified ? AUDIT_ACTIONS.userVerify : AUDIT_ACTIONS.userUnverify,
        targetType: "User",
        targetId: userId,
        summary: `${isVerified ? "Verified" : "Removed verification from"} ${
          target.displayName || target.email || userId
        }`,
        detail: { wasVerified: target.isVerified },
      });
      return api.success({ isVerified }, isVerified ? "User verified" : "Verification removed");
    }

    // BAN / UNBAN
    //
    // The verdict requireAuth keeps for a minute is dropped here, so the ban is
    // in force on the target's very next request rather than at the end of the
    // cache window — an admin who bans somebody and then checks is the exact
    // case the stale minute would look like the check not working.
    invalidateAccountStatus(userId);

    const isBanned = action === "BAN";
    const reason = body?.reason?.toString() || "Terms violation";
    await prisma.user.update({
      where: { id: userId },
      data: {
        isBanned,
        banReason: isBanned ? reason : null,
        strikes: isBanned ? 3 : 0,
      },
    });

    // The only durable record that this happened. `banReason` is NULLed by an
    // unban and `isBanned` is a boolean with no author, so without this line the
    // answer to "who suspended this creator, and why" exists nowhere.
    await recordAudit({
      actorId: auth.userId,
      action: isBanned ? AUDIT_ACTIONS.userBan : AUDIT_ACTIONS.userUnban,
      targetType: "User",
      targetId: userId,
      summary: `${isBanned ? "Suspended" : "Reinstated"} ${
        target.displayName || target.email || userId
      }${isBanned ? ` — reason: ${reason}` : ""}`,
      detail: {
        reason: isBanned ? reason : null,
        wasBanned: target.isBanned,
        // The ban unpublishes everything this creator had live; say how much, so
        // the log answers the first question asked afterwards.
        ...(isBanned ? { videosUnpublished: true } : {}),
      },
    });

    if (isBanned) {
      // Unpublish the creator's content while banned
      await prisma.video.updateMany({
        where: { creatorId: userId, isPublished: true },
        data: { isPublished: false },
      });
    }

    await prisma.notification.create({
      data: {
        userId,
        title: isBanned ? "Account suspended" : "Account reinstated",
        message: isBanned
          ? `Your account has been suspended: ${body?.reason || "Terms violation"}`
          : "Your account has been reinstated. Your videos can be republished.",
        type: isBanned ? "error" : "success",
        link: "/",
      },
    });

    return api.success({ isBanned }, isBanned ? "User banned" : "User unbanned");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Admin User Action Error]", error);
    return api.internal();
  }
}
