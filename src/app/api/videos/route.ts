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
import { clientIp, generateSlug, intParam } from "@/lib/utils";
import { cacheGet, cacheSet, cacheDel, checkRateLimit } from "@/lib/redis";
import { rankTrending, type TrendingItem } from "@/lib/trending";
import { normalizeMediaUrl } from "@/lib/media";
import { videoStatus } from "@/lib/video-status";
import config from "@/lib/config";
import {
  getStreamtapeUploadForCreator,
  verifyStreamtapeUploadSession,
} from "@/lib/streamtape-upload-session";
import { getFeatureFlags } from "@/lib/services/platform-setting.service";
import { publishDueVideos } from "@/lib/services/scheduled-publish.service";

/**
 * A non-negative integer query param, or `undefined` when absent or junk.
 *
 * `intParam` cannot be reused here: it floors at 1, which is right for a page
 * number and wrong for a price bound — `priceMin=0` (free scenes included in a
 * range) is a real filter, and "absent" has to stay distinguishable from it.
 */
function optionalPrice(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(100_000_000, parsed);
}

// =============================================================================
// GET /api/videos - Public feed with optional search
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    const { allowed } = await checkRateLimit(
      `videos:${clientIp(request.headers)}`,
      120,
      60_000
    );
    if (!allowed) return api.rateLimited("Too many requests — please wait a moment");

    // Publish any scheduled post whose time has arrived, BEFORE the feed is
    // read or its cache consulted. This is the whole reason the sweep lives
    // here: a viewer's request is the one that must not be wrong, so the request
    // that lists the feed is the request that guarantees a due post is in it.
    await publishDueVideos();

    const searchParams = request.nextUrl.searchParams;
    // intParam, not `parseInt`: a letter in the page number is NaN, and a NaN
    // `skip`/`take` is refused by Prisma — `/api/videos?page=abc` used to answer
    // 500 instead of the first page of the feed.
    const page = intParam(searchParams.get("page"), 1);
    const limit = intParam(searchParams.get("limit"), 20, 50);
    // Capped and folded before it reaches either the WHERE clause or the cache
    // key. An unbounded `q` made two problems: a 10,000-character `contains`
    // scan per request, and one distinct Redis key per distinct string — the
    // cheapest way to evict every legitimate entry with junk. `toLowerCase`
    // folds "Java" and "java" onto the same key, so the cache is not defeated
    // by capitalisation either.
    const search = (searchParams.get("q") || "").trim().slice(0, 100);
    const category = (searchParams.get("category") || "").trim().slice(0, 60);
    // A creator's own page asks for their videos with this. It used to be read
    // and ignored — the parameter was never put in the WHERE clause, so
    // /creator/<id> rendered the entire site feed under "Videos by <name>", and
    // the SEO shell said N published videos while the grid showed everyone's.
    const creatorId = searchParams.get("creatorId") || "";
    const sortBy = searchParams.get("sort") || "newest";
    const durationFilter = searchParams.get("duration") || ""; // short | medium | long
    const dateFilter = searchParams.get("date") || ""; // day | week | month | year
    // Price and creator-quality filters. `priceMin`/`priceMax` bound the price;
    // `maxPrice` is the "under X" shorthand the UI sends for its preset chips,
    // folded onto priceMax so the two cannot disagree. `verified=1` keeps only
    // videos by a blue-tick creator. All are clamped to sane integers so a junk
    // value cannot become a NaN bound Prisma refuses (or widen the cache).
    const minPrice = optionalPrice(searchParams.get("priceMin"));
    const priceMax = optionalPrice(
      searchParams.get("priceMax") ?? searchParams.get("maxPrice")
    );
    const verifiedOnly = searchParams.get("verified") === "1";
    const freeOnly = searchParams.get("free") === "1";

    // creatorId belongs in the key: without it one creator's page would be
    // served the cached general feed, and the bug above would survive the fix.
    // Every attacker-controlled part is bounded above, so the number of distinct
    // keys is finite.
    const cacheKey = `videos:list:${page}:${limit}:${search.toLowerCase()}:${category}:${sortBy}:${durationFilter}:${dateFilter}:${creatorId}:${minPrice ?? ""}:${priceMax ?? ""}:${verifiedOnly ? 1 : 0}:${freeOnly ? 1 : 0}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return api.success(cached);
    }

    const where = {
      isPublished: true,
      isDeleted: false,
      isFlagged: false,
      streamtapeFileId: { not: null },
      OR: [{ encodingStatus: null }, { encodingStatus: { not: 5 } }],
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
      // A creator id is a cuid; anything outside that shape cannot match a row
      // and only serves to widen the cache-key space, so it is dropped rather
      // than queried.
      ...(creatorId && /^[A-Za-z0-9_-]{1,64}$/.test(creatorId) ? { creatorId } : {}),
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
      // Free-only wins over any price bound: a viewer asking for free scenes
      // means exactly 0, not "0 to something".
      ...(freeOnly
        ? { price: 0 }
        : minPrice !== undefined || priceMax !== undefined
        ? {
            price: {
              ...(minPrice !== undefined ? { gte: minPrice } : {}),
              ...(priceMax !== undefined ? { lte: priceMax } : {}),
            },
          }
        : {}),
      ...(verifiedOnly ? { creator: { isVerified: true } } : {}),
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
      streamtapeFileId: true,
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
          streamtapeFileId: string | null;
          price: number;
          encodingStatus: number | null;
          encodeProgress: number;
        }[]
      ).map(
        ({
          streamtapeFileId,
          price,
          encodingStatus,
          encodeProgress,
          ...v
        }) => {
          const isImporting = typeof streamtapeFileId === "string" && streamtapeFileId.startsWith("pending_");
          const status = isImporting ? "PROCESSING" : videoStatus(encodingStatus, encodeProgress);

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
            encodeProgress: isImporting ? 0 : encodeProgress ?? 0,
            // Said out loud so a card never *hovers* a manifest that does not
            // exist yet: Bunny 404s a playlist until transcoding finishes, and
            // the preview would spend a request to find that out on every hover.
            playable:
              status === "READY" &&
              streamtapeFileId !== null &&
              !streamtapeFileId.startsWith("pending_"),
            teaserUrl: null,
            introUrl: null,
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

    // Operator kill switch: uploads can be paused without a deploy (a storage
    // incident, a moderation backlog). Refused before any upload work, and the
    // creator is told why rather than watching an upload fail at the end.
    const flags = await getFeatureFlags();
    if (!flags.uploadsEnabled && auth.role !== "ADMIN") {
      return api.error(
        "Uploads are temporarily paused. Your file was not sent — please try again shortly.",
        503,
        "UPLOADS_PAUSED"
      );
    }

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
      streamtapeFileId,
      thumbnailUrl,
      fileSize,
      uploadSessionToken,
      isDraft,
      publishAt,
    } = result.data;

    // A draft is unpublished; a future `publishAt` is scheduled; anything else
    // publishes now. Draft wins over a time, because "I am not finished" is a
    // stronger statement than "go live at 8".
    const holdAsDraft = isDraft === true;
    const scheduledAt = publishAt ? new Date(publishAt) : null;
    const publishLater =
      !holdAsDraft &&
      !!scheduledAt &&
      Number.isFinite(scheduledAt.getTime()) &&
      scheduledAt.getTime() > Date.now() + 60_000;
    const shouldPublish = !holdAsDraft && !publishLater;

    // The file is uploaded before this request. If the response is lost, the
    // creator retries finalization with the same Streamtape id. Treat that id
    // as the idempotency key and only allow its original creator to replay it.
    const existing = await prisma.video.findUnique({
      where: { streamtapeFileId },
      select: {
        id: true,
        creatorId: true,
        title: true,
        slug: true,
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

    const streamtapeSession = await verifyStreamtapeUploadSession(
      uploadSessionToken,
      auth.userId
    );
    if (!streamtapeSession) {
      return api.forbidden("This upload session does not belong to this video");
    }
    const uploadState = await getStreamtapeUploadForCreator(streamtapeSession.uploadId, auth.userId);
    if (!uploadState || !["IMPORTING", "READY", "LINKED"].includes(uploadState.state)) {
      return api.error(
        "The video is still being prepared. Wait for processing to finish and try again.",
        409,
        "UPLOAD_INCOMPLETE"
      );
    }

    const slug = await uniqueVideoSlug(title);

    const video = await prisma.video.create({
      data: {
        creatorId: auth.userId,
        title,
        description,
        slug,
        streamtapeFileId: uploadState.fileId ?? `pending_${streamtapeSession.uploadId}`,
        thumbnailUrl: normalizeMediaUrl(thumbnailUrl, config.bunnyStorage.cdnHostname),

        price,
        teaserDuration,
        category,
        tags: tags || [],
        // A scheduled or draft post is stored unpublished; the feed's existing
        // `isPublished: true` filter hides it with no change there, and
        // publishDueVideos() flips it when the time comes.
        isPublished: shouldPublish && Boolean(uploadState.fileId),
        isDraft: holdAsDraft,
        scheduledAt: publishLater ? scheduledAt : null,
        encodingStatus: uploadState.fileId ? null : 2,
        encodeProgress: uploadState.fileId ? 100 : 0,
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
    await cacheDel("home:feed:v3");

    return api.success(
      {
        ...video,
        status: uploadState.fileId
          ? videoStatus(video.encodingStatus, video.encodeProgress)
          : "PROCESSING",
      },
      holdAsDraft
        ? "Saved as a draft — publish it from your dashboard when you are ready"
        : publishLater
        ? `Scheduled — it goes live ${scheduledAt!.toLocaleString()}`
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
