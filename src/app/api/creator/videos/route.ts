// =============================================================================
// GENHUB - Creator Videos Route
// GET /api/creator/videos - The creator's own videos + Bunny processing state
//
// Money lives in /api/creator/balance; this route owns the processing lifecycle.
// Separating them keeps one source of truth per concern instead of a balance
// endpoint that also knows about video codecs.
//
// Reading this route ADVANCES the state: a creator watching the page is the
// most reliable signal that someone cares, and it means the lifecycle still
// works on a deployment with no scheduler configured. A re-check floor keeps a
// polling dashboard from flooding Bunny (see the service).
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import {
  describeEncoding,
  refreshCreatorPendingEncodings,
} from "@/lib/services/video-encoding.service";

const IN_FLIGHT = ["pending", "processing"];

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // `?refresh=0` lets a caller read the stored state without touching Bunny —
    // used by the very first render so a page load is never slower than the API
    // call it depends on.
    if (request.nextUrl.searchParams.get("refresh") !== "0") {
      try {
        await refreshCreatorPendingEncodings(auth.userId);
      } catch (error) {
        // A Bunny outage must not blank out the creator's video list.
        console.warn(
          "[Creator Videos] Encoding refresh failed:",
          (error as Error)?.message
        );
      }
    }

    const videos = await prisma.video.findMany({
      where: { creatorId: auth.userId, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        description: true,
        slug: true,
        price: true,
        isPublished: true,
        viewsCount: true,
        purchaseCount: true,
        // Without this the creator's own list had no image to show, which is how
        // a broken thumbnail stayed invisible to the one person who could fix it.
        thumbnailUrl: true,
        duration: true,
        teaserDuration: true,
        // The edit form owns title, price, description, cover, category, tags,
        // preview length and captions; a field the API does not return is a
        // field the creator cannot edit without retyping it from memory.
        category: true,
        tags: true,
        captionsUrl: true,
        encodingStatus: true,
        encodeProgress: true,
        encodingError: true,
        encodingCheckedAt: true,
        createdAt: true,
      },
    });

    const withEncoding = videos.map((video) => ({
      ...video,
      encoding: describeEncoding(video.encodingStatus, video.encodeProgress),
    }));

    return api.success({
      videos: withEncoding,
      // Drives the UI: poll only while something is actually moving.
      processing: withEncoding.filter((v) => IN_FLIGHT.includes(v.encoding.state)).length,
      // Held back from the public feed until Bunny can serve them.
      awaitingPublish: withEncoding.filter(
        (v) => !v.isPublished && IN_FLIGHT.includes(v.encoding.state)
      ).length,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Creator Videos Error]", error);
    return api.internal();
  }
}
