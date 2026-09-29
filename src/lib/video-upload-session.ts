// =============================================================================
// GENHUB - Signed Bunny upload sessions
//
// The signed session is stateless. It carries the Bunny TUS URL and its short
// lived authorization headers, but is bound to the authenticated creator by a
// server-side JWT signature. That keeps resume/finalize reliable on serverless
// instances without making Redis a hidden dependency of video uploads.
// =============================================================================

import { SignJWT, jwtVerify } from "jose";
import config from "@/lib/config";
import {
  createTusUpload,
  tusAuthHeaders,
  tusUploadOffset,
  cancelTusUpload,
  TUS_AUTH_TTL_SECONDS,
} from "@/lib/bunny-tus";
import { createVideoUpload, deleteBunnyVideo } from "@/lib/bunny";
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

function validUploadUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "video.bunnycdn.com";
  } catch {
    return false;
  }
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
  const { userId, title, totalBytes, mimeType } = params;
  const slot = await createVideoUpload(title);
  const expiresAt = Math.floor(Date.now() / 1000) + TUS_AUTH_TTL_SECONDS;

  try {
    const created = await createTusUpload({
      libraryId: slot.libraryId,
      apiKey: config.bunny.apiKey,
      videoId: slot.videoId,
      total: totalBytes,
      mimeType,
      expiresAt,
      timeoutMs: 20_000,
    });

    if (!created.ok || !validUploadUrl(created.uploadUrl)) {
      throw new Error(created.ok ? "Bunny returned an invalid upload URL" : created.detail);
    }

    const headers = await tusAuthHeaders({
      libraryId: slot.libraryId,
      apiKey: config.bunny.apiKey,
      videoId: slot.videoId,
      expiresAt,
    });

    const session: Omit<VerifiedVideoUploadSession, "sessionToken"> = {
      userId,
      videoId: slot.videoId,
      uploadUrl: created.uploadUrl,
      headers,
      totalBytes,
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
    const totalBytes = payload.totalBytes;
    const expiresAt = payload.expiresAt;

    if (
      payload.userId !== userId ||
      typeof payload.videoId !== "string" ||
      !validUploadUrl(payload.uploadUrl) ||
      !payload.headers ||
      typeof payload.headers !== "object" ||
      typeof totalBytes !== "number" ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return null;
    }

    return {
      sessionToken,
      userId,
      videoId: payload.videoId,
      uploadUrl: payload.uploadUrl,
      headers: payload.headers as Record<string, string>,
      totalBytes,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export async function confirmVideoUpload(
  session: VerifiedVideoUploadSession
): Promise<{ ok: true; offset: number } | { ok: false; status: number; detail: string }> {
  const offset = await tusUploadOffset({
    uploadUrl: session.uploadUrl,
    headers: session.headers,
    timeoutMs: 20_000,
  });

  if (offset !== session.totalBytes) {
    return {
      ok: false,
      status: 409,
      detail: `Bunny has ${offset} of ${session.totalBytes} bytes`,
    };
  }
  return { ok: true, offset };
}

export async function abortVideoUploadSession(
  session: VerifiedVideoUploadSession
): Promise<void> {
  await cancelTusUpload({ uploadUrl: session.uploadUrl, headers: session.headers }).catch(() => undefined);
  await deleteBunnyVideo(session.videoId).catch(() => undefined);
}
