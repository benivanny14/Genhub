// =============================================================================
// GENHUB - Publication status for videos a page is already showing
// POST /api/videos/status  { ids: string[] }
//
// The other half of instant publication. A post exists the moment its bytes
// reach the host (see /api/videos POST), so a feed can be full of cards whose
// video is still being transcoded — and those cards have to turn into players
// by themselves, without the viewer reloading the page to find out.
//
// ONE request per page, not one per card. A page asks about every unfinished
// video it is showing, together, which is the difference between one small
// query every few seconds and twenty. The list is bounded (see MAX_IDS) so a
// caller cannot turn this into a scan of the table.
//
// READ-ONLY, and deliberately so. It answers from what is already stored and
// never talks to Bunny: a viewer's open tab must not be able to spend an API
// call at the host, and every finished encode is already being written by the
// webhook, the cron sweep and the owner's own page read. This endpoint only
// reports what those wrote.
//
// PUBLIC, because the answer is about posts that are published: nothing here
// is a secret (a Bunny status code and a percentage), no row that is deleted is
// ever named, and requiring a session would leave a signed-out visitor on a
// processing post forever.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { videoStatus } from "@/lib/video-status";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";

/**
 * The most ids one request may ask about.
 *
 * Above the largest page any screen of ours renders (50 in the subscription
 * feed) with room to spare, so no legitimate caller is refused, and well below
 * the point where the `in` clause stops being an index lookup.
 */
const MAX_IDS = 100;

/** Long enough for a cuid; anything longer cannot name a row we have. */
const MAX_ID_LENGTH = 64;

/**
 * The shape of an id we will hand to the database.
 *
 * A row id is a cuid (letter + alphanumerics) and a slug is lowercase
 * alphanumerics with dashes, so anything outside `[A-Za-z0-9_-]` is a string
 * that cannot name a row. Refusing it here keeps a flood of junk ids from ever
 * reaching the `in` clause.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Polling limit.
 *
 * A page polls this while a post is transcoding — one small request every few
 * seconds per open tab. 240 a minute per IP is far above any legitimate page and
 * well below the rate at which the endpoint could be used as a free table scan.
 */
const STATUS_MAX = 240;
const STATUS_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(`vstatus:${ip}`, STATUS_MAX, STATUS_WINDOW_MS);
    if (!allowed) return api.rateLimited("Too many status checks — please wait a moment");

    const body = await readJsonBody(request);
    const raw = (body as { ids?: unknown } | null)?.ids;

    if (!Array.isArray(raw)) {
      return api.validation("ids must be an array of video ids");
    }

    // Deduplicated and trimmed here: two cards can be watching the same id
    // (a grid and a sidebar), and asking twice would return one row twice. Also
    // shape-checked and capped, so a caller cannot turn this into a scan.
    const ids = [
      ...new Set(
        raw
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id))
      ),
    ].slice(0, MAX_IDS);

    if (ids.length === 0) {
      return api.success({ statuses: {}, processing: 0 });
    }

    // Who is asking decides which rows they may learn about. An anonymous
    // caller may only ever hear about PUBLISHED, non-deleted videos: an
    // unpublished row (pulled from the feed, or still being uploaded) must not
    // have its existence or its encode progress revealed to a stranger, or this
    // endpoint becomes an oracle for "is there a hidden video with this id?".
    // The creator and an admin may see their own unpublished rows, which is how
    // the creator's own "View as viewer" and dashboard polling work.
    const viewer = await getCurrentUser();

    const rows = await prisma.video.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: {
        id: true,
        encodingStatus: true,
        encodeProgress: true,
        isPublished: true,
        creatorId: true,
      },
    });

    const statuses: Record<string, { status: string; progress: number }> = {};
    for (const row of rows) {
      const maySeePrivate =
        !!viewer && (viewer.role === "ADMIN" || viewer.userId === row.creatorId);
      if (!row.isPublished && !maySeePrivate) continue;
      statuses[row.id] = {
        status: videoStatus(row.encodingStatus, row.encodeProgress),
        // `?? 0` because the column is non-null in the schema but a row written
        // before it existed can still read as null through an old client.
        progress: row.encodeProgress ?? 0,
      };
    }

    return api.success({
      statuses,
      // Lets a caller stop polling the moment nothing can change any more.
      processing: Object.values(statuses).filter((s) => s.status === "PROCESSING").length,
    });
  } catch (error) {
    console.error("[Video Status Error]", error);
    return api.internal();
  }
}
