// =============================================================================
// GENHUB - A signed session for uploading the background clip
// =============================================================================
// The clip can be up to 500 MB, and no byte of it may pass through this
// application: a serverless function does not accept more than 4.5 MB, so the
// body would be refused by the platform before the route existed. The browser
// therefore PUTs the file straight to R2, and everything this server does about
// it is sign the destination and later confirm what arrived.
//
// TWO CREDENTIALS, TWO JOBS, AND NEITHER IS REUSABLE
//
//   * the presigned URL covers ONE object, ONE verb, and expires. A client
//     holding it can fill its own slot and nothing else — no listing, no
//     reading, no deleting.
//   * the session token is a JWT signed by this server, carrying the same
//     object key, the media type and the admin it was issued to. It is what the
//     confirmation step trusts, and it is why a client cannot complete an upload
//     it never started: without it, "point the setting at this token" would be
//     an instruction any caller could give.
//
// The shape is deliberately the same as the creator video upload session
// (lib/video-upload-session.ts): one way of doing this in the codebase, not two.
// =============================================================================

import { SignJWT, jwtVerify } from "jose";
import config from "@/lib/config";
import { backgroundVideoExtension } from "@/lib/background-video";
import { isR2Configured, presignR2Url, r2BackgroundKey } from "@/lib/r2";

const ISSUER = "genhub";
const AUDIENCE = "background-video-upload";

/**
 * How long the upload may take.
 *
 * Six hours, and it is a deliberate ceiling rather than a guess: this is the
 * same window the creator video transport allows, and it has to outlast a large
 * clip on a slow phone connection — an expired signature stops a transfer
 * halfway through with a 403 that reads like a permissions problem.
 */
export const BACKGROUND_VIDEO_UPLOAD_TTL_SECONDS = 6 * 60 * 60;

/** Whether this deployment can start an upload at all. */
export function isBackgroundVideoUploadConfigured(): boolean {
  return isR2Configured() && Boolean(config.jwtSecret) && config.jwtSecret !== "dev-secret-change-in-production";
}

function secret(): Uint8Array {
  if (!isBackgroundVideoUploadConfigured()) {
    throw new Error("JWT_SECRET and R2 credentials must be configured before a clip can be uploaded");
  }
  return new TextEncoder().encode(config.jwtSecret);
}

export interface BackgroundVideoUpload {
  /** The clip's token: the object's name here and the version in its URL. */
  token: string;
  /** Where the bytes go inside the bucket. Derived on the server, never sent. */
  key: string;
  mimeType: string;
  name: string;
  /** What the client said the file weighs. Checked against R2 before it is live. */
  size: number;
}

export interface StartedBackgroundVideoUpload extends BackgroundVideoUpload {
  sessionToken: string;
  /** Presigned PUT. Hand this to the client WITH `headers`, and to nobody else. */
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export async function startBackgroundVideoUpload(params: {
  userId: string;
  token: string;
  mimeType: string;
  name: string;
  size: number;
}): Promise<StartedBackgroundVideoUpload> {
  const { userId, token, mimeType, name, size } = params;
  // Derived, never taken from the caller — one place decides how a clip is
  // named, and the confirmation below re-derives it the same way.
  const extension = backgroundVideoExtension(mimeType);
  if (!extension) throw new Error(`refusing to open an upload for ${mimeType}`);
  const key = r2BackgroundKey(token, extension);

  // The content type is signed because R2 stores whatever it is told, and this
  // is the value the serving route later sends to every browser as the clip's
  // media type. An unsigned header would let the uploader decide that.
  const presigned = presignR2Url({
    method: "PUT",
    key,
    contentType: mimeType,
    expiresInSeconds: BACKGROUND_VIDEO_UPLOAD_TTL_SECONDS,
  });

  const sessionToken = await new SignJWT({ userId, token, key, mimeType, name, size })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(presigned.expiresAt)
    .sign(secret());

  return {
    sessionToken,
    token,
    key,
    mimeType,
    name,
    size,
    uploadUrl: presigned.url,
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
  };
}

/**
 * Read a session back, or null if it is not one this server issued for this
 * admin.
 *
 * Re-checked field by field rather than trusted wholesale: the key must still
 * sit under the clips' own directory and must still agree with the token and the
 * media type the session claims, so a session signed before some future change
 * to the rules cannot be replayed against the new ones.
 */
export async function verifyBackgroundVideoUpload(
  sessionToken: string,
  userId: string
): Promise<BackgroundVideoUpload | null> {
  try {
    const verified = await jwtVerify(sessionToken, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const payload = verified.payload as Partial<BackgroundVideoUpload & { userId: string }>;
    const { token, key, mimeType, name, size } = payload;

    if (payload.userId !== userId) return null;
    if (typeof token !== "string" || !/^[0-9a-f]{24}$/.test(token)) return null;
    if (typeof mimeType !== "string" || typeof key !== "string") return null;
    if (typeof name !== "string" || name.length > 200) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;

    // The key is derived from the token and the media type, so it has to equal
    // what those two produce. Anything else is a session pointing at an object
    // this deployment would never have written — and the extension lookup also
    // re-checks the media type against the one allowlist, so a session naming a
    // type we no longer store has nowhere to go.
    const extension = backgroundVideoExtension(mimeType);
    if (!extension || key !== r2BackgroundKey(token, extension)) return null;

    return { token, key, mimeType, name, size };
  } catch {
    return null;
  }
}
