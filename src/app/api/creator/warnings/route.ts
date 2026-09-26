// =============================================================================
// GENHUB - Warnings a creator has to read
// GET  /api/creator/warnings  - every warning issued, and which are unread
// POST /api/creator/warnings  - { id } — acknowledge reading one
//
// A warning is the step before a ban. It was delivered as a notification, which
// means it was delivered to a bell the creator can simply not open — and a
// creator who never reads it keeps uploading until the ban lands, which fails
// them and wastes the warning. So the record of the warning carries the record
// of its being read (`StrikeLog.acknowledgedAt`), and the dashboard blocks on
// the unacknowledged ones.
//
// Acknowledging is server-side and scoped to the signed-in creator, so it cannot
// be simulated by editing local storage, and one person cannot mark another's
// warning read.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET(_request: NextRequest) {
  try {
    const auth = await requireAuth();

    const [warnings, strikes, user] = await Promise.all([
      prisma.strikeLog.findMany({
        where: { creatorId: auth.userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          action: true,
          reason: true,
          videoId: true,
          createdAt: true,
          acknowledgedAt: true,
          issuedBy: true,
        },
      }),
      // The count the warning itself talks about ("strike 2/3"). Read live so
      // an old warning cannot quote a number that has since changed.
      prisma.strikeLog.count({ where: { creatorId: auth.userId, action: "WARNING" } }),
      prisma.user.findUnique({
        where: { id: auth.userId },
        select: { strikes: true },
      }),
    ]);

    const unread = warnings.filter((w) => w.acknowledgedAt === null);

    return api.success({
      warnings: warnings.map((w) => ({
        id: w.id,
        action: w.action,
        reason: w.reason,
        videoId: w.videoId,
        createdAt: w.createdAt.toISOString(),
        acknowledgedAt: w.acknowledgedAt?.toISOString() ?? null,
      })),
      /** The ones the dashboard must block on, oldest first: read them in order. */
      unread: unread
        .map((w) => ({
          id: w.id,
          action: w.action,
          reason: w.reason,
          videoId: w.videoId,
          createdAt: w.createdAt.toISOString(),
          acknowledgedAt: null,
        }))
        .reverse(),
      warningCount: strikes,
      strikes: user?.strikes ?? 0,
      /** True when any issued warning carries a consequence. */
      hasSerious: warnings.some((w) => w.action !== "WARNING"),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Warnings List Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : null;
    if (!id) return api.validation("id is required");

    // `acknowledgedAt: null` in the filter, not just the id: acknowledging twice
    // must not move the timestamp, which is the record of when the creator
    // actually read it.
    const acknowledged = await prisma.strikeLog.updateMany({
      where: { id, creatorId: auth.userId, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });

    if (acknowledged.count === 0) {
      const exists = await prisma.strikeLog.findFirst({
        where: { id, creatorId: auth.userId },
        select: { id: true },
      });
      if (!exists) return api.notFound("That warning does not exist");
      return api.success({ acknowledged: true }, "Already acknowledged");
    }

    // The bell has been telling this creator to read something they have now
    // read. Leaving those rows unread leaves a badge counting a job that is
    // done — the reader would check the bell, find nothing new, and stop
    // trusting it.
    await prisma.notification.updateMany({
      where: {
        userId: auth.userId,
        isRead: false,
        title: { contains: "Warning", mode: "insensitive" },
      },
      data: { isRead: true },
    });

    return api.success({ acknowledged: true }, "Warning acknowledged");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Warning Acknowledge Error]", error);
    return api.internal();
  }
}
