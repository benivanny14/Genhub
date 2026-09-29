// =============================================================================
// GENHUB - Bunny.net Upload Credentials Route
// POST /api/videos/upload-signature
//
// Reserves a video slot in Bunny Stream and returns the credentials the
// creator's browser uploads the file with. The library API key stays on this
// server — see createVideoUpload() in lib/bunny.ts for why the browser cannot
// talk to the management API itself.
//
// TWO TRANSPORTS, ONE ANSWER. The size the file picker reported decides which:
//
//   * one presigned URL that lets the browser PUT the whole file straight into
//     the R2 bucket — for anything that fits in a single part; or
//   * a multipart plan, begun HERE and answered with its upload id, for
//     everything bigger (lib/upload-multipart.ts explains why: a 192 MB file
//     over a 1.55 Mbps link is seventeen minutes, and a single request that is
//     cut at forty seconds loses everything it had sent).
//
// `presigned` and `multipart` are mutually exclusive, so the page never chooses:
// it sends the file down whichever road this response opened (lib/upload-send.ts).
//
// The slot was reserved here, by this server, with the key: the browser never
// gets one, for either transport.
//
// A deployment with no bucket configured answers 503 instead of handing out
// something the client cannot use. That is a refusal on purpose: the alternative
// is an upload that looks authorized, sends a whole video, and then fails at the
// ingest — the creator's data spent on a configuration mistake they cannot see.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { createVideoUpload, deleteBunnyVideo } from "@/lib/bunny";
import {
  beginMultipartUpload,
  createPresignedUploadTarget,
  isPresignedUploadConfigured,
  needsMultipart,
  partCountFor,
} from "@/lib/upload-target";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Verify KYC is approved
    const prisma = (await import("@/lib/db")).default;

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { kycStatus: true, isBanned: true },
    });

    if (!user || user.kycStatus !== "APPROVED") {
      return api.forbidden("Your KYC must be approved before you can upload videos");
    }

    if (user.isBanned) {
      return api.forbidden("Your account is blocked");
    }

    // Every call here creates a real object in the Bunny library, and Bunny
    // charges for the storage and the transcode. Approved KYC says who a creator
    // is; it says nothing about how much of the library one account may consume,
    // so the only limit used to be the internet. Same ceiling as an image
    // upload, which is far above a human picking a file and far below a script.
    const { allowed } = await checkRateLimit(
      `videoslot:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads at once — wait a few minutes and try again");
    }

    const held = await prisma.video.count({
      where: { creatorId: auth.userId, isDeleted: false },
    });
    if (held >= config.business.maxVideosPerCreator) {
      return api.forbidden(
        `This account already holds ${held} videos, which is the limit. Delete something you no longer publish, or contact support.`
      );
    }

    // Bunny Stream must be configured before we can create an upload target;
    // return a clear configuration error instead of an opaque 500.
    if (!config.bunny.libraryId || !config.bunny.apiKey) {
      return api.error(
        "Bunny Stream is not configured (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY)",
        503,
        "NOT_CONFIGURED"
      );
    }

    // And the storage has to be configured BEFORE a slot is reserved — which is
    // why this check sits above the create below rather than beside its result.
    // Reserving costs a real object in the Bunny library, so an environment that
    // cannot accept an upload must refuse before it makes one. Checked afterwards
    // (as it first was), a deployment with no bucket refused every upload AND
    // left an empty video behind each time, for every creator, until somebody
    // noticed the library filling up with nothing.
    if (!isPresignedUploadConfigured()) {
      return api.error(
        "Video uploads are not available right now — the upload storage is not configured. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }

    const body = await request.json().catch(() => ({}));
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : `Video ${Date.now()}`;

    // The size the file picker already knows, and the only thing that decides
    // which transport this upload gets. It is a LIE THE CLIENT CAN TELL — it
    // could claim 1 byte and then send 2 GB — and that is deliberate, because the
    // alternative is the server refusing a file it cannot measure: what a wrong
    // size costs is a creator whose huge file is sent as one request, which is
    // exactly what the parts exist to avoid, and never a credential the server
    // did not mean to hand out. The key is derived from the video id either way,
    // and both transports write the same object.
    const reportedSize = Number(body.size);

    const result = await createVideoUpload(title);

    if (Number.isFinite(reportedSize) && needsMultipart(reportedSize)) {
      try {
        // Begun here rather than by the browser: an unfinished multipart upload
        // is a real entry in the bucket, and a client that could begin them at
        // will could leave thousands behind.
        console.info(
          `[Upload Signature] ${result.videoId}: multipart, ${partCountFor(reportedSize)} parts of ~8 MiB for ${reportedSize} bytes`
        );
        const multipart = await beginMultipartUpload(result.videoId, reportedSize);
        return api.success(
          {
            ...result,
            presigned: null,
            multipart,
            presignedConfigured: isPresignedUploadConfigured(),
          },
          "Upload credentials created"
        );
      } catch (error) {
        // The slot is already reserved, and a reservation that cannot be filled
        // must not stay in the library: this is the exact shape that filled a
        // live library with empty slots. Best effort — the creator's failure is
        // the one worth reporting, and a bucket that will not begin an upload
        // will usually not let go of a video either.
        await deleteBunnyVideo(result.videoId).catch(() => undefined);
        console.error("[Upload Signature Error]", error);
        return api.error(
          "The video storage refused to start the upload. Please try again in a moment — if it keeps happening, tell support.",
          502,
          "STORAGE_REFUSED"
        );
      }
    }

    // A last line of defence rather than a real branch: the check above already
    // refused a deployment that cannot sign, so reaching here means the two
    // halves of the storage configuration disagreed between the two calls — and
    // a reservation that cannot be filled must not be handed out even then.
    const presigned = createPresignedUploadTarget(result.videoId);

    if (!presigned) {
      await deleteBunnyVideo(result.videoId).catch(() => undefined);
      return api.error(
        "Video uploads are not available right now — the upload storage is not configured. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }

    return api.success(
      {
        ...result,
        presigned,
        multipart: null,
        presignedConfigured: isPresignedUploadConfigured(),
      },
      "Upload credentials created"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Signature Error]", error);
    return api.internal();
  }
}
