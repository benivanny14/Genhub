// =============================================================================
// GENHUB - Notifications API Route
// GET /api/notifications - List user notifications
// PATCH /api/notifications - Mark notifications as read
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import { intParam } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // How many to return. The bell asks for the default (50); the
    // /notifications page asks for more, because that page IS the history and
    // stopping it at a drop-down's worth of rows is what keeps a creator from
    // finding the reason their withdrawal was rejected. Clamped, so a query
    // string cannot turn this into an unbounded read.
    const limit = intParam(request.nextUrl.searchParams.get("limit"), 50, 200);

    const notifications = await prisma.notification.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: limit,
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

    const { allowed } = await checkRateLimit(`notif:${auth.userId}`, 120, 60_000);
    if (!allowed) return api.rateLimited("Too many actions — please wait a moment");

    // One notification, or all of them. Opening one from the bell marks that one
    // — it is the difference between "I have read this" and "I have read
    // everything", and a bell that clears itself because one line was opened is
    // a bell that hides the other four.
    //
    // Scoped by userId as well as by id: the id comes from the browser, and an
    // update that matched only on it would let any signed-in user mark somebody
    // else's notification read.
    const body = await readJsonBody(request);
    const id = typeof body?.id === "string" && body.id ? body.id : null;

    await prisma.notification.updateMany({
      where: { userId: auth.userId, isRead: false, ...(id ? { id } : {}) },
      data: { isRead: true },
    });

    return api.success(null, id ? "Notification read" : "Tarishe zimeonekana");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Mark Read Error]", error);
    return api.internal();
  }
}
