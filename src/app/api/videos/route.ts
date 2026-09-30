// =============================================================================
// GENHUB - Videos API Route
// GET /api/videos - List published videos (feed)
// POST /api/videos - Create a new video (creator only)
// =============================================================================

import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import prisma from "@/lib/db";
import { requireAuth, requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { createVideoSchema } from "@/lib/validation";
import { generateSlug, intParam } from "@/lib/utils";
import {
  getBunnyVideoDetails,
  introClipPath,
  isBunnyConfigured,
  isBunnyVideoId,
  resolveTeaserUrl,
} from "@/lib/bunny";
import { cacheGet, cacheSet, cacheDel } from "@/lib/redis";
import { rankTrending, type TrendingItem } from "@/lib/trending";
import { normalizeMediaUrl } from "@/lib/media";
import { BUNNY_FAILED, videoStatus } from "@/lib/video-status";
import config from "@/lib/config";
import { confirmVideoUpload, verifyVideoUploadSession } from "@/lib/video-upload-session";

// =============================================================================
// GET /api/videos - Public feed with optional search
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    // intParam, not `parseInt`: a letter in the page number is NaN, and a NaN
    // `skip`/`take` is refused by Prisma — `/api/videos?page=abc` used to answer
    // 500 instead of the first page of the feed.
    const page = intParam(searchParams.get("page"), 1);
    const limit = intParam(searchParams.get("limit"), 20, 50);
    const search = searchParams.get("q") || "";
    const category = searchParams.get("category") || "";
    // A creator's own page asks for their videos with this. It used to be read
    // and ignored — the parameter was never put in the WHERE clause, so
    // /creator/<id> rendered the entire site feed under "Videos by <name>", and
    // the SEO shell said N published videos while the grid showed everyone's.
    const creatorId = searchParams.get("creatorId") || "";
    const sortBy = searchParams.get("sort") || "newest";
    const durationFilter = searchParams.get("duration") || ""; // short | medium | long
    const dateFilter = searchParams.get("date") || ""; // day | week | month | year

    // creatorId belongs in the key: without it one creator's page would be
    // served the cached general feed, and the bug above would survive the fix.
    const cacheKey = `videos:list:${page}:${limit}:${search}:${category}:${sortBy}:${durationFilter}:${dateFilter}:${creatorId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return api.success(cached);
    }

    const where = {
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
      // A post whose encode Bunny has FAILED is not published, even though the
      // row is: it can never play, so leaving it in the grid is a card that
      // opens onto an apology. Written as "not tracked, or not failed" rather
      // than `{ not: 5 }`, because a `not` comparison against a NULL column
      // matches nothing — and NULL is every side-loaded, demo and pre-lifecycle
      // video in the catalogue, which would empty the feed.
      OR: [{ encodingStatus: null }, { encodingStatus: { not: BUNNY_FAILED } }],
      ...(search
        ? {
            // The two ORs cannot share a key: search is ANDed onto the filter
            // above, not merged into it.
            AND: [
              {
                OR: [
                  { title: { contains: search, mode: "insensitive" as const } },
                  { description: { contains: search, mode: "insensitive" as const } },
                ],
              },
            ],
          }
        : {}),
      ...(category ? { category } : {}),
      ...(creatorId ? { creatorId } : {}),
      ...(durationFilter
        ? {
            duration:
              durationFilter === "short"
                ? { lt: 300 }
                : durationFilter === "medium"
                ? { gte: 300, lt: 1200 }
                : { gte: 1200 },
          }
        : {}),
      ...(dateFilter
        ? {
            createdAt: {
              gte: new Date(
                Date.now() -
                  ({ day: 1, week: 7, month: 30, year: 365 }[dateFilter] || 365) *
                    86400000
              ),
            },
          }
        : {}),
    };

    const orderBy =
      sortBy === "popular"
        ? { viewsCount: "desc" as const }
        : sortBy === "rated"
          ? { likesCount: "desc" as const }
          : sortBy === "price_low"
          ? { price: "asc" as const }
          : sortBy === "price_high"
            ? { price: "desc" as const }
            : sortBy === "featured"
              ? { isFeatured: "desc" as const }
              : { createdAt: "desc" as const };

    const videoSelect = {
      id: true,
      title: true,
      slug: true,
      description: true,
      thumbnailUrl: true,
      previewUrl: true,
      bunnyVideoId: true,
      teaserBunnyVideoId: true,
      teaserClipUrl: true,
      price: true,
      teaserDuration: true,
      duration: true,
      viewsCount: true,
      likesCount: true,
      purchaseCount: true,
      category: true,
      isPremium: true,
      isFeatured: true,
      tags: true,
      createdAt: true,
      // Bunny's own numbers, so a card can tell "this is live" from "this is
      // live but still transcoding" — an Instagram-like post exists before it
      // can play, and the card has to show that rather than a dead player. Raw
      // Bunny ids stay out of every response; a status code and a percentage
      // tell a viewer nothing they did not already know.
      encodingStatus: true,
      encodeProgress: true,
      creator: {
        select: {
          id: true,
          // The public handle travels with the creator so a feed card can show
          // @someone instead of a display name two accounts can share.
          username: true,
          displayName: true,
          avatarUrl: true,
          isVerified: true,
        },
      },
    } as const;

    const total = await prisma.video.count({ where });

    let videos: Record<string, unknown>[];

    if (sortBy === "trending") {
      // Smart trending: engagement weighted by recency (shared lib/trending.ts)
      const pool = await prisma.video.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
        select: videoSelect,
      });
      videos = rankTrending(pool as unknown as TrendingItem[]).slice(
        (page - 1) * limit,
        page * limit
      ) as unknown as Record<string, unknown>[];
    } else {
      videos = (await prisma.video.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        select: videoSelect,
      })) as Record<string, unknown>[];
    }

    const result = {
      videos: (
        videos as unknown as {
          id: string;
          bunnyVideoId: string;
          previewUrl: string | null;
          teaserBunnyVideoId: string | null;
          teaserClipUrl: string | null;
          price: number;
          encodingStatus: number | null;
          encodeProgress: number;
        }[]
      ).map(
        ({
          bunnyVideoId,
          previewUrl,
          teaserBunnyVideoId,
          teaserClipUrl,
          price,
          encodingStatus,
          encodeProgress,
          ...v
        }) => {
          // The trailer clip when one exists, the video itself when it is free,
          // and null for a paid scene with no trailer — never a throw, so one
          // video with a Bunny id on an unconfigured library cannot break the feed.
          // `id` is the row id: a Bunny-hosted trailer is served through
          // /api/videos/<rowId>/stream so its manifest can be rewritten rather
          // than handed to a player that cannot authorise its segments.
          const teaserUrl = resolveTeaserUrl({
            id: v.id,
            bunnyVideoId,
            previewUrl,
            teaserBunnyVideoId,
            teaserClipUrl,
            price,
          });

          const status = videoStatus(encodingStatus, encodeProgress);

          return {
            ...v,
            // Destructured out only for the resolver — the client needs it back,
            // or every card loses its price badge.
            price,
            // One word for the card to switch on: `PROCESSING` posts render the
            // thumbnail, the badge and no playback; everything else behaves
            // exactly as before.
            status,
            // The card also shows how far along it is, which is the only thing
            // that answers "is this moving?" while a creator waits.
            encodeProgress: encodeProgress ?? 0,
            // Said out loud so a card never *hovers* a manifest that does not
            // exist yet: Bunny 404s a playlist until transcoding finishes, and
            // the preview would spend a request to find that out on every hover.
            playable: status === "READY",
            teaserUrl,
            // What a card plays on hover when the scene is LOCKED. A paid scene
            // with no uploaded trailer resolves to a null teaser, and without
            // this the whole grid would move on hover except the scenes the page
            // exists to sell. Sixteen seconds cut from the scene, signed per
            // file, so it is safe for anyone to receive.
            introUrl: teaserUrl ? null : introClipPath({ id: v.id, bunnyVideoId }),
          };
        }
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    await cacheSet(cacheKey, result, 60); // Cache 1 minute
    return api.success(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[List Videos Error]", error);
    return api.internal();
  }
}

// =============================================================================
// POST /api/videos - Create video (Creator only)
// =============================================================================

/**
 * A slug nobody else holds.
 *
 * `Video.slug` is `@unique`, and `generateSlug` is a pure function of the
 * title — so two videos with the same title computed the SAME slug and the
 * insert died on the unique constraint. The route answered a generic 500
 * AFTER the creator's file had already been uploaded in full: no video
 * appeared anywhere, and the natural retry reserved ANOTHER Bunny slot and
 * abandoned the first one. Two creators naming a scene the same thing, or one
 * creator re-submitting after that first failure, was enough to lose a 1.8 GB
 * upload and pay for two of them.
 *
 * The title keeps its meaning; only the URL suffix moves. "-2", "-3", … up to
 * a bound, then a random tail so an unlucky run cannot spin here.
 *
 * A title with nothing slug-worthy in it ("🌶️") slugs to the empty string,
 * which is as collidable as any other value — hence the "video" floor.
 */
async function uniqueVideoSlug(title: string): Promise<string> {
  const base = generateSlug(title) || "video";

  for (let suffix = 1; suffix <= 25; suffix += 1) {
    const candidate = (suffix === 1 ? base : `${base}-${suffix}`).slice(0, 100);
    const taken = await prisma.video.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  return `${base.slice(0, 88)}-${randomBytes(4).toString("hex")}`;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Check KYC
    if (auth.role !== "ADMIN") {
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { kycStatus: true, isBanned: true },
      });

      if (!user || user.kycStatus !== "APPROVED") {
        return api.forbidden(
          "You must complete KYC before uploading videos"
        );
      }

      if (user.isBanned) {
        return api.forbidden("Your account is blocked");
      }
    }

    const body = await readJsonBody(request);
    const result = createVideoSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const {
      title,
      description,
      price,
      teaserDuration,
      category,
      tags,
      bunnyVideoId,
      teaserBunnyVideoId,
      thumbnailUrl,
      fileSize,
      uploadSessionToken,
      teaserUploadSessionToken,
    } = result.data;

    // The file is uploaded before this request. If the response is lost, the
    // creator retries finalization with the same Bunny id; creating a second
    // row (or surfacing a unique-constraint 500) makes a successful upload look
    // lost and encourages a second Bunny upload. Treat the Bunny id as the
    // idempotency key and only allow its original creator to replay it.
    const existing = await prisma.video.findUnique({
      where: { bunnyVideoId },
      select: {
        id: true,
        creatorId: true,
        title: true,
        slug: true,
        bunnyVideoId: true,
        price: true,
        isPublished: true,
        encodingStatus: true,
        encodeProgress: true,
        createdAt: true,
      },
    });

    if (existing) {
      const { creatorId: existingCreatorId, ...existingPublic } = existing;
      if (existingCreatorId !== auth.userId) {
        // No provider name in a client-facing message: which host holds the
        // asset is our business, and the creator's question is whose video it is.
        return api.forbidden("That video is already linked to another creator");
      }

      const awaitingTranscode = existingPublic.encodingStatus !== null;
      return api.success(
        {
          ...existingPublic,
          status: videoStatus(existingPublic.encodingStatus, existingPublic.encodeProgress),
        },
        awaitingTranscode
          ? "Video post already finalized and is still processing"
          : "Video post already finalized",
        200
      );
    }

    // A new creator post must be backed by a signed Bunny TUS session that
    // belongs to this creator. This closes the old gap where a client could
    // submit any valid-looking Bunny GUID after another creator's upload.
    if (isBunnyConfigured()) {
      if (!uploadSessionToken) {
        return api.validation("The completed video upload session is missing");
      }

      const mainSession = await verifyVideoUploadSession(uploadSessionToken, auth.userId);
      if (!mainSession || mainSession.videoId !== bunnyVideoId) {
        return api.forbidden("This upload session does not belong to this video");
      }

      const mainConfirmed = await confirmVideoUpload(mainSession);
      if (!mainConfirmed.ok) {
        return api.error(
          "The video has not finished uploading yet. Continue the upload and try again.",
          409,
          "UPLOAD_INCOMPLETE"
        );
      }

      if (teaserBunnyVideoId) {
        if (!teaserUploadSessionToken) {
          return api.validation("The teaser upload session is missing");
        }
        const teaserSession = await verifyVideoUploadSession(teaserUploadSessionToken, auth.userId);
        if (!teaserSession || teaserSession.videoId !== teaserBunnyVideoId) {
          return api.forbidden("This teaser upload session does not belong to this video");
        }
        const teaserConfirmed = await confirmVideoUpload(teaserSession);
        if (!teaserConfirmed.ok) {
          return api.error(
            "The teaser upload is not complete yet. Continue it and try again.",
            409,
            "TEASER_UPLOAD_INCOMPLETE"
          );
        }
      }
    }

    // A browser supplies the id, but it must not be allowed to turn an
    // arbitrary string (or another creator's asset) into a published row. The
    // signed upload path is the source of truth; this finalization check makes
    // sure Bunny still knows both assets before the database commit.
    if (isBunnyConfigured()) {
      if (!isBunnyVideoId(bunnyVideoId)) {
        return api.validation(
          "That upload could not be verified. Please upload the video again."
        );
      }
      if (teaserBunnyVideoId && !isBunnyVideoId(teaserBunnyVideoId)) {
        return api.validation(
          "That trailer could not be verified. Please upload the trailer again."
        );
      }
      try {
        const assets = await Promise.all([
          getBunnyVideoDetails(bunnyVideoId),
          ...(teaserBunnyVideoId && isBunnyVideoId(teaserBunnyVideoId)
            ? [getBunnyVideoDetails(teaserBunnyVideoId)]
            : []),
        ]);
        for (const [index, asset] of assets.entries()) {
          const expected = index === 0 ? bunnyVideoId : teaserBunnyVideoId;
          const returned = String((asset as { guid?: unknown })?.guid ?? "");
          if (expected && returned && returned.toLowerCase() !== expected.toLowerCase()) {
            // A mismatch is an upstream fault and reads as one. The ids involved
            // are logged with a reference; the creator is told the upload could
            // not be confirmed and what to do about it.
            return api.upstream(
              `asset mismatch: asked for ${expected}, host returned ${returned}`,
              {
                context: "VideoCreate",
                status: 502,
                code: "ASSET_MISMATCH",
                message:
                  "That upload could not be confirmed. Please submit it again — nothing has been published.",
              }
            );
          }
        }
      } catch (error) {
        console.error("[Create Video] asset verification against the video host failed", error);
        return api.error(
          "This upload could not be verified yet. Please submit again shortly.",
          503,
          "UPLOAD_VERIFY_FAILED"
        );
      }
    }

    const slug = await uniqueVideoSlug(title);

    // Bunny accepts an upload seconds after the creator's browser starts
    // sending, but the video is unplayable until transcoding finishes. This
    // used to hold the row back (`isPublished: false`) until Bunny could serve
    // it, which meant a creator's post simply did not exist for anyone —
    // including themselves — for the minutes a phone upload + transcode takes,
    // and the failure they described was "my video never appears".
    //
    // Publication is now INSTANT and playback is what waits: the row is created
    // published with encodingStatus 0, the feed and the creator's profile show
    // it immediately behind an "Inachakatwa..." badge, and the badge is
    // replaced by the player in place when the host finishes (the webhook, the
    // cron sweep and the client poll all converge on that one state — see
    // lib/video-status.ts).
    //
    // A row whose encode FAILS is hidden from the public feed by the GET above,
    // so "published but unplayable" cannot become a permanent dead card; the
    // creator still sees it, with Bunny's reason, on their dashboard.
    //
    // Side-loaded/demo rows (synthetic ids, which Bunny never transcodes) keep
    // encodingStatus null and are READY from the first moment, exactly as
    // before.
    const awaitingTranscode = isBunnyConfigured() && isBunnyVideoId(bunnyVideoId);

    const video = await prisma.video.create({
      data: {
        creatorId: auth.userId,
        title,
        description,
        slug,
        bunnyVideoId,
        teaserBunnyVideoId: teaserBunnyVideoId ?? null,
        // Healed on write: a creator pasting the old Bunny CDN URL (or a value
        // copied from an older video) is stored as /api/media/<key> instead, so
        // the site never again publishes a link that 403s.
        thumbnailUrl: normalizeMediaUrl(thumbnailUrl, config.bunny.cdnHostname),

        price,
        teaserDuration,
        category,
        tags: tags || [],
        isPublished: true,
        encodingStatus: awaitingTranscode ? 0 : null,
        // The creator's own size, kept beside the host's number so the dashboard
        // can answer "did the whole file arrive?" instead of only "does the host
        // hold anything?". Recorded here because this is the only moment the
        // browser still has the file in hand.
        uploadSizeBytes: fileSize ?? null,
        // createVideoSchema guarantees this is true (18 U.S.C. § 2257)
        complianceAttestedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        bunnyVideoId: true,
        price: true,
        isPublished: true,
        encodingStatus: true,
        encodeProgress: true,
        createdAt: true,
      },
    });

    // The feed is cached for a minute, and a creator who has just uploaded is
    // looking at their own profile to see it appear. Without this the post is
    // real, published and invisible for up to a minute — which reads exactly
    // like the bug this change removes.
    await cacheDel("videos:*");

    return api.success(
      {
        ...video,
        status: videoStatus(video.encodingStatus, video.encodeProgress),
      },
      awaitingTranscode
        ? "Video posted — it is already on your profile while it finishes processing"
        : "Video created successfully",
      201
    );
  } catch (error: any) {
    console.error("[Create Video Error]", error);
    if (error.message?.includes("Insufficient")) {
      return api.forbidden(error.message);
    }
    return api.internal();
  }
}
