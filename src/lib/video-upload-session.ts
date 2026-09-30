// =============================================================================
// GENHUB - Signed Bunny upload sessions
//
// The signed session is stateless. It carries the Bunny video slot's id and the
// short-lived presigned credentials for Bunny's TUS endpoint, but is bound to
// the authenticated creator by a server-side JWT signature. That keeps
// resume/finalize reliable on serverless instances without making Redis a hidden
// dependency of video uploads.
//
// IT DELIBERATELY CARRIES NO `uploadUrl`
//
// It used to: this file opened the TUS resource itself and handed the browser a
// ready URL. That works from one machine and fails in production, because Bunny
// serves a TUS resource only to the network that created it — a session opened
// by a Vercel function answered 200 (offset 0) to that same function and an
// empty 404 "Not Found" to the phone that had to send the bytes through it.
// Emulator runs reproduced it exactly: the app's own sessions died on the very
// first chunk, while identical sessions opened from the phone's side of the
// network uploaded the whole file and Bunny encoded it.
//
// So the browser opens the upload (see `openVideoUpload` in lib/video-upload.ts)
// and this module only reserves the slot and signs the credentials — which is
// Bunny's own documented shape for a browser upload: their signing example hands
// the presigned headers to a client-side TUS library.
// =============================================================================

import { SignJWT, jwtVerify } from "jose";
import config from "@/lib/config";
import { tusAuthHeaders, TUS_AUTH_TTL_SECONDS } from "@/lib/bunny-tus";
import { createVideoUpload, deleteBunnyVideo, getBunnyVideoDetails } from "@/lib/bunny";
import type { VideoUploadSession } from "@/lib/video-upload";

const ISSUER = "genhub";
const AUDIENCE = "video-upload";

/**
 * Whether this deployment can sign an upload session at all.
 *
 * The session token is a JWT, so video uploads now depend on JWT_SECRET in a way
 * the old transport did not. A missing (or still-default) secret is a
 * deployment mistake, not a fault at Bunny, and the route checks this up front
 * so the operator is told which one they have instead of a 502 that blames the
 * video host.
 */
export function isUploadSessionConfigured(): boolean {
  return Boolean(config.jwtSecret) && config.jwtSecret !== "dev-secret-change-in-production";
}

function secret(): Uint8Array {
  if (!isUploadSessionConfigured()) {
    throw new Error("JWT_SECRET must be configured before video uploads can start");
  }
  return new TextEncoder().encode(config.jwtSecret);
}

/**
 * The four headers Bunny revalidates on every TUS request.
 *
 * A session carrying fewer than all four cannot be used, and Bunny reports the
 * gap as a 404 that reads like an upload that has gone away — so it is refused
 * here, where the reason is still knowable.
 */
const SIGNED_HEADERS = [
  "AuthorizationSignature",
  "AuthorizationExpire",
  "LibraryId",
  "VideoId",
] as const;

function hasSignedHeaders(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  const headers = value as Record<string, unknown>;
  return SIGNED_HEADERS.every((name) => typeof headers[name] === "string" && headers[name] !== "");
}

export interface VerifiedVideoUploadSession extends VideoUploadSession {
  userId: string;
}

export async function createVideoUploadSession(params: {
  userId: string;
  title: string;
  totalBytes: number;
  mimeType?: string;
}): Promise<VideoUploadSession> {
  const { userId, title, totalBytes, mimeType = "video/mp4" } = params;
  const slot = await createVideoUpload(title);
  const expiresAt = Math.floor(Date.now() / 1000) + TUS_AUTH_TTL_SECONDS;

  try {
    const headers = await tusAuthHeaders({
      libraryId: slot.libraryId,
      apiKey: config.bunny.apiKey,
      videoId: slot.videoId,
      expiresAt,
    });

    const session: Omit<VideoUploadSession, "sessionToken"> & { userId: string } = {
      userId,
      videoId: slot.videoId,
      headers,
      totalBytes,
      mimeType,
      expiresAt,
    };

    const sessionToken = await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(secret());

    return { ...session, sessionToken };
  } catch (error) {
    await deleteBunnyVideo(slot.videoId).catch(() => undefined);
    throw error;
  }
}

export async function verifyVideoUploadSession(
  sessionToken: string,
  userId: string
): Promise<VerifiedVideoUploadSession | null> {
  try {
    const verified = await jwtVerify(sessionToken, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const payload = verified.payload as Partial<VerifiedVideoUploadSession>;
    const { totalBytes, expiresAt, headers } = payload;

    if (
      payload.userId !== userId ||
      typeof payload.videoId !== "string" ||
      !payload.videoId ||
      typeof payload.mimeType !== "string" ||
      !hasSignedHeaders(headers) ||
      typeof totalBytes !== "number" ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return null;
    }

    // The credentials must belong to the video the session names and to this
    // deployment's library. Without this a session could name one slot while
    // carrying the signed key for another, and the bytes would land somewhere
    // the row never looks.
    if (headers.VideoId !== payload.videoId || headers.LibraryId !== config.bunny.libraryId) {
      return null;
    }

    return {
      sessionToken,
      userId,
      videoId: payload.videoId,
      headers,
      totalBytes,
      mimeType: payload.mimeType,
      expiresAt,
    };
  } catch {
    return null;
  }
}

/** How many times, and how patiently, an upload's arrival is checked. */
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_INTERVAL_MS = 1_200;

/**
 * Has Bunny actually got the file?
 *
 * This used to be a HEAD against the TUS resource, which was exact but is now
 * the wrong instrument twice over: the resource belongs to the browser's network
 * (a HEAD from here answers 404), and the browser is the party whose claim is in
 * question. Bunny's management API answers the same question from any region:
 * a slot is created as status 0 and only moves off it once the declared length
 * has arrived, so a stalled transfer cannot pass this check however confidently
 * the client says it finished.
 *
 * The wait exists because the status change is Bunny's own bookkeeping and lands
 * a moment after the last byte: an immediate single look would refuse uploads
 * that had, in fact, just completed.
 */
export async function confirmVideoUpload(
  session: VerifiedVideoUploadSession
): Promise<{ ok: true; offset: number } | { ok: false; status: number; detail: string }> {
  let lastStatus = -1;

  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    let details: { status?: unknown; length?: unknown } | null = null;
    try {
      details = await getBunnyVideoDetails(session.videoId);
    } catch {
      return {
        ok: false,
        status: 502,
        detail: "the video service could not be asked about this upload",
      };
    }

    const status = Number(details?.status);
    const length = Number(details?.length);
    lastStatus = Number.isFinite(status) ? status : -1;

    if (lastStatus >= 1 || (Number.isFinite(length) && length > 0)) {
      return { ok: true, offset: session.totalBytes };
    }

    if (attempt < CONFIRM_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_INTERVAL_MS));
    }
  }

  return {
    ok: false,
    status: 409,
    detail: `Bunny still lists this video as empty (status ${lastStatus})`,
  };
}

/**
 * Give up on a slot the creator abandoned.
 *
 * Only the video object is removed. The TUS resource itself lives at a URL the
 * browser learned from Bunny, so the server no longer holds a handle on it —
 * and deleting the slot is what matters: it is the slot that would sit in the
 * library forever as an unexplained empty video.
 */
export async function abortVideoUploadSession(
  session: VerifiedVideoUploadSession
): Promise<void> {
  await deleteBunnyVideo(session.videoId).catch(() => undefined);
}
