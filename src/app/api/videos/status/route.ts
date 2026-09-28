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
import { videoStatus } from "@/lib/video-status";

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const raw = (body as { ids?: unknown } | null)?.ids;

    if (!Array.isArray(raw)) {
      return api.validation("ids must be an array of video ids");
    }

    // Deduplicated and trimmed here: two cards can be watching the same id
    // (a grid and a sidebar), and asking twice would return one row twice.
    const ids = [
      ...new Set(
        raw
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id.length <= MAX_ID_LENGTH)
      ),
    ].slice(0, MAX_IDS);

    if (ids.length === 0) {
      return api.success({ statuses: {}, processing: 0 });
    }

    const rows = await prisma.video.findMany({
      where: { id: { in: ids }, isDeleted: false },
      select: { id: true, encodingStatus: true, encodeProgress: true },
    });

    const statuses: Record<string, { status: string; progress: number }> = {};
    for (const row of rows) {
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
