// =============================================================================
// GENHUB - Single-PUT upload target (server side)
//
// What the browser is handed when the creator's file will go up in one request
// through the proxy in worker/bunny-upload, instead of in chunks straight to
// Bunny. See lib/upload-proxy-token.ts for what the token does and does not
// authorize, and bunny.ts's upload section for why the management key cannot go
// to a browser at all.
//
// The whole path is OPTIONAL and off by default. With no proxy configured this
// returns null, the sign-in response carries no proxy target, and the browser
// uploads with TUS exactly as before — which is what makes this shippable
// without a Worker deployed and without a flag day.
// =============================================================================

import config from "./config";
import { signUploadProxyToken, uploadProxyUrl } from "./upload-proxy-token";
import type { BunnyUploadCredentials } from "./bunny";

export interface UploadProxyTarget {
  /** Where the browser PUTs the whole file, authorization included. */
  url: string;
  /**
   * The largest file this path accepts.
   *
   * A single PUT has no resume and no second chance at the same offset, and the
   * proxy itself refuses request bodies over its plan's ceiling — a refusal the
   * creator can do nothing about. The client therefore only takes this path when
   * the file fits, and falls back to the resumable one when it does not.
   */
  maxBytes: number;
}

/**
 * What /api/videos/upload-signature hands the browser: the reservation, the
 * presigned resumable credentials, and — when the proxy is configured — the
 * single-PUT target beside them.
 *
 * Named as a separate type rather than an optional field on
 * BunnyUploadCredentials because the resumable credentials are produced by
 * Bunny's own signing and know nothing about the proxy; pretending they carry it
 * would mean the one place that DOES add it (the route) could forget to without
 * anything noticing.
 */
export interface UploadTarget extends BunnyUploadCredentials {
  proxy: UploadProxyTarget | null;
}

/** True when both halves of the proxy configuration are present. */
export function isUploadProxyConfigured(): boolean {
  return Boolean(config.bunny.uploadProxyUrl && config.bunny.uploadProxySecret);
}

/**
 * A token for one reserved video id, or null when the path is not configured.
 *
 * The lifetime is short on purpose — an hour is far longer than the wait between
 * reserving a slot and starting to send bytes, and far shorter than the 24h the
 * TUS authorization allows, because unlike that one this token sits in a URL
 * that proxy logs will keep.
 */
export async function createUploadProxyTarget(
  videoId: string,
  ttlSeconds: number = 3_600
): Promise<UploadProxyTarget | null> {
  if (!isUploadProxyConfigured()) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await signUploadProxyToken(
    config.bunny.uploadProxySecret,
    videoId,
    expiresAt
  );

  return {
    url: uploadProxyUrl({
      baseUrl: config.bunny.uploadProxyUrl,
      videoId,
      expiresAt,
      token,
    }),
    maxBytes: config.bunny.uploadProxyMaxBytes,
  };
}
