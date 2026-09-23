// =============================================================================
// GENHUB - Notifications API Route
// GET /api/notifications - List user notifications
// PATCH /api/notifications - Mark notifications as read
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const notifications = await prisma.notification.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const unreadCount = await prisma.notification.count({
      where: { userId: auth.userId, isRead: false },
    });

    return api.success({ notifications, unreadCount });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Notifications Error]", error);
    return api.internal();
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Mark all as read
    await prisma.notification.updateMany({
      where: { userId: auth.userId, isRead: false },
      data: { isRead: true },
    });

    return api.success(null, "Tarishe zimeonekana");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Mark Read Error]", error);
    return api.internal();
  }
}
