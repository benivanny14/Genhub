// =============================================================================
// GENHUB - Watch Progress API Route
// POST /api/videos/[id]/progress - Save playback position (resume/continue)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, getCurrentUser, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";

/**
 * How much the saved position must move before a write is worth doing.
 *
 * The player posts every few seconds, but two posts five seconds apart carry
 * almost the same number. Writing only on a meaningful move — or after the row
 * has gone stale (see QUIET_WRITE_MS) — keeps a viewer watching a paused scene
 * from writing the same row on a timer, which is a cheap way to drive database
 * load from one open tab.
 */
const MIN_POSITION_DELTA_SECONDS = 5;

/** A no-move post older than this is still written, so a pause is not lost. */
const QUIET_WRITE_MS = 30_000;

/** No position or duration is longer than a day; anything more is garbage. */
const MAX_SECONDS = 24 * 60 * 60;

// GET /api/videos/[id]/progress - Saved position (for resume playback)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Next 15 hands route params over as a promise — read before the session,
    // so a signed-out viewer takes the same path as one with an account.
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return api.success({ positionSeconds: 0, percent: 0 });
    }

    const progress = await prisma.watchProgress.findUnique({
      where: { userId_videoId: { userId: user.userId, videoId: id } },
      select: { positionSeconds: true, percent: true },
    });

    return api.success(progress || { positionSeconds: 0, percent: 0 });
  } catch (error) {
    console.error("[Get Watch Progress Error]", error);
    return api.internal();
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth();

    // Per ACCOUNT, not per IP: the thing to bound here is one session's write
    // rate, and an IP is shared by a whole household or a phone network. 120 a
    // minute is four times what the 5-second player interval produces.
    const { allowed } = await checkRateLimit(`progress:${auth.userId}`, 120, 60_000);
    if (!allowed) return api.rateLimited("Too many progress updates — please wait a moment");

    const { id } = await params;

    const body = await readJsonBody(request, {});
    // Bounded both ways: negative is nonsense, and a number larger than a day is
    // a client bug or an attempt to store a sentinel. A duration of 0 is left as
    // "unknown" and yields 0%, never a divide-by-zero.
    const positionSeconds = Math.min(
      MAX_SECONDS,
      Math.max(0, Math.floor(Number(body?.positionSeconds) || 0))
    );
    const duration = Math.min(MAX_SECONDS, Math.max(0, Math.floor(Number(body?.duration) || 0)));
    const percent =
      duration > 0 ? Math.min(100, Math.max(0, Math.round((positionSeconds / duration) * 100))) : 0;

    const video = await prisma.video.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!video) return api.notFound("Video not found");

    // Server-side debounce: read the row and skip the write when the position
    // barely moved and the last write is still fresh. The answer is identical
    // either way, so the player cannot tell — it just stops being a write
    // amplifier. A stale row is always written, so a genuine pause is kept.
    const existing = await prisma.watchProgress.findUnique({
      where: { userId_videoId: { userId: auth.userId, videoId: id } },
      select: { positionSeconds: true, updatedAt: true },
    });

    if (existing) {
      const moved = Math.abs(existing.positionSeconds - positionSeconds);
      const fresh = Date.now() - existing.updatedAt.getTime() < QUIET_WRITE_MS;
      if (moved < MIN_POSITION_DELTA_SECONDS && fresh) {
        return api.success({ positionSeconds: existing.positionSeconds, percent });
      }
    }

    await prisma.watchProgress.upsert({
      where: { userId_videoId: { userId: auth.userId, videoId: id } },
      create: {
        userId: auth.userId,
        videoId: id,
        positionSeconds,
        percent,
      },
      update: {
        positionSeconds,
        percent,
        updatedAt: new Date(),
      },
    });

    return api.success({ positionSeconds, percent });
  } catch (error) {
    if (error instanceof AuthError) {
      return api.unauthorized(error.message);
    }
    console.error("[Watch Progress Error]", error);
    return api.internal();
  }
}
