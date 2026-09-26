// =============================================================================
// GENHUB - Single Video API Route
// GET /api/videos/[id] - Get video details + signed playback URL
// PATCH /api/videos/[id] - Update video (creator only)
// DELETE /api/videos/[id] - Delete video (creator or admin)
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUser, requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { updateVideoSchema } from "@/lib/validation";
import {
  resolvePlaybackUrl,
  resolveTeaserUrl,
  introPreviewPath,
  deleteBunnyVideo,
} from "@/lib/bunny";
import { resolveVideoEntitlement, type EntitlementSource } from "@/lib/services/video-entitlement.service";
import { normalizeMediaUrl } from "@/lib/media";
import config from "@/lib/config";
import { describeEncoding } from "@/lib/services/video-encoding.service";
import { cacheDel, claimOnce } from "@/lib/redis";
import { clientIp } from "@/lib/utils";

// =============================================================================
// GET /api/videos/[id]
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = await params;
    const authUser = await getCurrentUser();

    // "View as visitor" — a creator or an admin asking what a customer would
    // get. It DOWNGRADES the request and can never escalate one: every access
    // decision below is made as if nobody were signed in, so the answer is the
    // anonymous answer (no `hasAccess`, no playback URL, no teaser that only a
    // buyer or a trailer would produce).
    //
    // It exists because of a report that is impossible to settle by reading the
    // screen: the creator and an admin ARE entitled to the video on purpose
    // (services/video-entitlement.service.ts), so every page plays for them and
    // a working paywall looks broken. Asking the server for the visitor's answer
    // is the only way to see it without signing out.
    const asVisitor = request.nextUrl.searchParams.get("asVisitor") === "1";
    const viewer = asVisitor ? null : authUser;

    const video = await prisma.video.findFirst({
      where: {
        OR: [{ id }, { slug: id }],
        isDeleted: false,
      },
      include: {
        creator: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        // Scene photo gallery (Brazzers-style image set under the player)
        galleryImages: { orderBy: { position: "asc" } },
      },
    });

    if (!video) {
      return api.notFound("Video not found");
    }

    // Unpublished is private. The page shell refuses these too, but this route
    // is reachable on its own, and a row id is guessable enough — the only
    // people who may read a video that is not live are its creator (previewing
    // their own upload) and an admin.
    const maySeeUnpublished =
      authUser?.userId === video.creatorId || authUser?.role === "ADMIN";
    if (!video.isPublished && !maySeeUnpublished) {
      return api.notFound("Video not found");
    }

    // Count the view, once per viewer per hour.
    //
    // This used to be an unconditional increment on every GET, which made
    // `viewsCount` a number anybody could raise by refreshing — and it is not a
    // vanity metric, it is the ranking input for /most-viewed and the
    // `viewsCount` sort on the feed. So the ranking was for sale to whoever was
    // willing to hold F5, and a page load that never reached the paywall counted
    // as a view of a scene nobody watched.
    //
    // Keyed on the account when there is one (a person and their phone are one
    // viewer) and on the address otherwise, so a signed-out visitor still counts
    // — just not sixty times a minute.
    const viewerKey = authUser?.userId ?? `ip:${clientIp(request.headers)}`;
    // Counting a creator's own preview would inflate the number the feed ranks
    // on, and it is not a view anybody watched.
    const isOwnerPreview = authUser?.userId === video.creatorId && !video.isPublished;
    const counted = (await claimOnce(`view:${video.id}:${viewerKey}`, 3_600)) && !isOwnerPreview;

    if (counted) {
      await prisma.video.update({
        where: { id: video.id },
        data: { viewsCount: { increment: 1 } },
      });
    }

    // Check if user has access (purchased)
    let hasAccess = false;
    let playbackUrl: string | null = null;
    let teaserUrl: string | null = null;

    // Teaser for anyone who has not paid: the creator's separate trailer clip
    // when one exists, the video itself only when it is free, otherwise nothing.
    // A paid scene must never be previewed by signing its own stream, because a
    // Bunny token cannot limit duration — see resolveTeaserUrl.
    teaserUrl = resolveTeaserUrl(video);

    // Free videos (price = 0) are open to everyone — no purchase row needed.
    // Without this branch, free videos stayed hasAccess=false forever and the
    // "Free to Watch" row could never actually be watched in full.
    const isFree = video.price === 0;

    // Where access comes from — lets the UI say "Purchased", "Included in your
    // subscription" or "Full access" instead of guessing. Resolved by the one
    // shared service so this route cannot disagree with the stream and download
    // routes about who is entitled to what.
    let accessSource: EntitlementSource | null = null;

    // A charge for this video that is neither confirmed nor denied: the customer
    // approved the USSD prompt and the gateway never settled it. The paywall
    // must show "we are checking — do not pay again" instead of "Buy".
    let paymentUnderInvestigation: {
      transactionId: string;
      providerRef: string | null;
      amount: number;
      createdAt: string;
    } | null = null;

    if (isFree) {
      hasAccess = true;
      accessSource = "free";
      playbackUrl = resolvePlaybackUrl(video, 10, authUser?.userId);
    } else if (viewer) {
      const entitlement = await resolveVideoEntitlement(video, {
        userId: viewer.userId,
        role: viewer.role,
      });

      hasAccess = entitlement.entitled;
      accessSource = entitlement.source;

      // Generate full playback URL only if user has access
      if (hasAccess) {
        playbackUrl = resolvePlaybackUrl(video, 10, viewer.userId);
      }

      // No access yet — but is a charge for THIS video stuck in limbo? A USSD
      // prompt that was approved and never settled leaves the customer in the
      // worst possible place: no video, and no way to know whether they paid.
      // Surfaced here (server-side, on first render) so the paywall can refuse
      // to sell them the same video twice.
      if (!hasAccess) {
        const unresolved = await prisma.transaction.findFirst({
          where: {
            userId: viewer.userId,
            videoId: video.id,
            type: "PPV_PURCHASE",
            status: "UNDER_INVESTIGATION",
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, amount: true, providerRef: true, createdAt: true },
        });
        if (unresolved) {
          paymentUnderInvestigation = {
            transactionId: unresolved.id,
            providerRef: unresolved.providerRef,
            amount: unresolved.amount,
            createdAt: unresolved.createdAt.toISOString(),
          };
        }
      }
    }

    // `include:` (not `select:`) means the entire row is in hand, so anything
    // internal would be published here — and any column added to Video later
    // would leak by default. Playback, the teaser and downloads are all resolved
    // server-side now, so the client has no use for the raw Bunny id, and
    // moderation state must never be public: isFlagged tells the world which
    // reports landed, and complianceAttestedAt is an internal legal record.
    //
    // previewUrl is the FULL scene for side-loaded and demo rows (Bunny rows use
    // bunnyVideoId, but those producers are seeded with previewUrl), and the
    // client never reads it — playback and teaser arrive already resolved in
    // `playbackUrl`/`teaserUrl`. Leaving it in meant any logged-out visitor
    // could GET this route and stream a paid scene for free.
    const {
      previewUrl: _previewUrl,
      bunnyVideoId: _bunnyVideoId,
      teaserBunnyVideoId: _teaserBunnyVideoId,
      teaserClipUrl: _teaserClipUrl,
      isFlagged: _isFlagged,
      isDeleted: _isDeleted,
      complianceAttestedAt: _complianceAttestedAt,
      // The encoding columns are stripped for the same reason as the rest: the
      // client gets the ONE curated `encoding` object below instead of the raw
      // row. `encodingNotifiedAt` is internal bookkeeping, and `encodingError`
      // can carry Bunny's own diagnostics.
      encodingStatus: _encodingStatus,
      encodeProgress: _encodeProgress,
      encodingError: _encodingError,
      encodingCheckedAt: _encodingCheckedAt,
      encodingNotifiedAt: _encodingNotifiedAt,
      ...publicVideo
    } = video;

    // The intro a viewer with no entitlement sees. A creator-uploaded trailer
    // wins (`teaserUrl` above, already resolved); when there is none, Bunny's own
    // generated animated preview fills the gap so the page is never an empty
    // black box. Buyers need neither, so it is not even computed for them.
    //
    // The value is an IN-APP url, not the signed CDN one: this pull zone refuses
    // any request that carries a Referer, and a browser always sends one for an
    // <img> — so the CDN URL 200s in curl and 403s in the page. The route that
    // serves it holds the token, and the token opens only that one file, never
    // the scene's playlist.
    const introPreviewUrl =
      !hasAccess && !teaserUrl ? introPreviewPath(video) : null;

    return api.success({
      ...publicVideo,
      // Bunny transcodes after the upload finishes, so a video can be live but
      // not yet playable — most often because the creator published it early
      // (see /api/creator/videos/[id]/publish). Saying so is the difference
      // between "this site is broken" and "this is still processing".
      encoding: describeEncoding(video.encodingStatus, video.encodeProgress),
      hasAccess,
      accessSource,
      paymentUnderInvestigation,
      playbackUrl,
      teaserUrl,
      introPreviewUrl,
      viewsCount: video.viewsCount + (counted ? 1 : 0), // Reflect the view we just added
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Get Video Error]", error);
    return api.internal();
  }
}

// =============================================================================
// PATCH /api/videos/[id] - Update video
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    // Find video
    const video = await prisma.video.findUnique({ where: { id } });
    if (!video) return api.notFound();

    // Only creator or admin can update
    if (video.creatorId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden();
    }

    const body = await request.json();
    const result = updateVideoSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    // The same rule the upload schema enforces, checked against the row that is
    // actually stored. It matters more here than it does at upload time, because
    // this is the route that can point the teaser column of an ALREADY LIVE
    // video at the video itself — and the teaser door serves without asking for
    // entitlement, so the result would be a paid scene playable by anyone,
    // signed in or not.
    if (result.data.teaserBunnyVideoId && result.data.teaserBunnyVideoId === video.bunnyVideoId) {
      return api.validation("The teaser must be a different video from the main video");
    }

    const updated = await prisma.video.update({
      where: { id },
      data: {
        ...result.data,
        // Same healing as create: a stored Bunny CDN URL is rewritten to the
        // in-app path that actually serves the file.
        ...(result.data.thumbnailUrl !== undefined
          ? { thumbnailUrl: normalizeMediaUrl(result.data.thumbnailUrl, config.bunny.cdnHostname) }
          : {}),
        // "" is the form's way of saying "remove them". Storing the empty string
        // would leave a <track> whose src is the current page, so the removal is
        // written as NULL — one value that means "no captions", not two.
        ...(result.data.captionsUrl !== undefined
          ? { captionsUrl: result.data.captionsUrl === "" ? null : result.data.captionsUrl }
          : {}),
      },
      select: {
        id: true,
        title: true,
        description: true,
        price: true,
        isPublished: true,
        captionsUrl: true,
        updatedAt: true,
      },
    });

    // Invalidate caches
    await cacheDel(`videos:*`);

    return api.success(updated, "Video updated");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Update Video Error]", error);
    return api.internal();
  }
}

// =============================================================================
// DELETE /api/videos/[id] - Soft delete video
// =============================================================================

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await requireAuth();
    const { id } = await params;

    const video = await prisma.video.findUnique({ where: { id } });
    if (!video) return api.notFound();

    if (video.creatorId !== auth.userId && auth.role !== "ADMIN") {
      return api.forbidden();
    }

    // Soft delete
    await prisma.video.update({
      where: { id },
      data: { isDeleted: true, isPublished: false },
    });

    // Also delete from Bunny.net
    try {
      await deleteBunnyVideo(video.bunnyVideoId);
    } catch (e) {
      console.error("[Bunny Delete Error]", e);
      // Continue even if Bunny delete fails
    }

    await cacheDel(`videos:*`);

    return api.success(null, "Video deleted");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Delete Video Error]", error);
    return api.internal();
  }
}
