// =============================================================================
// GENHUB - What can THIS device actually reach?
// GET  /api/videos/upload-check  -> two signed URLs a browser can really use
// POST /api/videos/upload-check  -> what happened when it did
//
// The question this answers is the one the failure records could not. A browser
// gives a page no reason for a cross-origin failure: `status: 0` covers a DNS
// failure, a refused preflight, a reset connection and a CORS policy refusal, and
// on 2026-09-29 a phone that had uploaded 192 MB an hour earlier had every later
// part PUT die in under a second with zero bytes acknowledged, with nothing in
// the system able to say which of the four it was.
//
// So the server hands the DEVICE two URLs it is allowed to use:
//
//   * a presigned PUT for a whole small object, and
//   * a presigned PUT for part 1 of a real multipart upload it just began.
//
// The second one is the point. A page cannot craft a CORS preflight — the
// `Access-Control-Request-*` headers are forbidden to scripts — so the only way
// to ask the bucket whether it will accept a part from this address is to make a
// request that really is one. It is signed for a probe key, so the answer costs
// nothing but a cancelled upload and a kilobyte.
//
// WHY IT IS CLEANED UP ON THE WAY BACK. Beginning a multipart upload is real
// state in the bucket, and the abort is made here when the device reports — so a
// check that runs leaves nothing behind, whatever it found. Best effort: the
// creator's answer must never depend on a bucket letting go.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit, cacheSet } from "@/lib/redis";
import config from "@/lib/config";
import { isR2Configured, signR2Request } from "@/lib/r2-sign";
import {
  UPLOAD_PART_BYTES,
  abortMultipartUpload,
  beginMultipartUpload,
  createPresignedUploadTarget,
  signPartUpload,
} from "@/lib/upload-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The object a check writes and then removes. Under the same prefix as every
 *  other upload, so the bucket's own age-based sweep would catch one left by a
 *  device that never came back. */
function probeId(): string {
  return `probe-${crypto.randomUUID()}`;
}

export async function GET() {
  try {
    const auth = await requireRole("CREATOR");

    if (!isR2Configured(config.r2)) {
      return api.error(
        "The upload storage is not configured, so there is nothing to check. Tell support.",
        503,
        "NOT_CONFIGURED"
      );
    }

    // Same ceiling as reserving a slot: this creates a real multipart upload.
    const { allowed } = await checkRateLimit(
      `uploadcheck:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many checks at once — wait a few minutes and try again");
    }

    const id = probeId();
    const whole = createPresignedUploadTarget(id);
    if (!whole) {
      return api.error("The upload storage is not configured. Tell support.", 503, "NOT_CONFIGURED");
    }

    const multipart = await beginMultipartUpload(id, UPLOAD_PART_BYTES);
    const part = signPartUpload(id, multipart.uploadId, 1);

    return api.success(
      {
        origin: "the address this page is open on",
        wholeObject: { url: whole.url, key: whole.key },
        part: {
          url: part.url,
          key: part.key,
          uploadId: multipart.uploadId,
          partNumber: 1,
        },
      },
      "Probe URLs signed"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Check Error]", error);
    return api.internal();
  }
}

const schema = z.object({
  probeId: z.string().min(1).max(200),
  uploadId: z.string().min(1).max(1024),
  reach: z
    .object({ ok: z.boolean(), ms: z.number(), error: z.string().optional() })
    .partial()
    .nullable()
    .optional(),
  whole: z
    .object({ ok: z.boolean(), status: z.number().nullable(), ms: z.number(), error: z.string().optional() })
    .partial()
    .nullable()
    .optional(),
  part: z
    .object({ ok: z.boolean(), status: z.number().nullable(), ms: z.number(), error: z.string().optional() })
    .partial()
    .nullable()
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const { probeId: id, uploadId, reach, whole, part } = parsed.data;

    // Recorded before it is cleaned up, so a check that ran is readable after the
    // bucket has forgotten it — this is the one screen-free way a creator's answer
    // to "what can your phone reach?" reaches somebody who can act on it.
    const summary = { at: new Date().toISOString(), reach, whole, part };
    if (process.env.NODE_ENV === "production") {
      console.info(`[Upload Check] ${auth.userId}: ${JSON.stringify(summary)}`);
    }
    await cacheSet(`upload:check:${auth.userId}`, summary, 7 * 24 * 60 * 60);

    await abortMultipartUpload(id, uploadId);
    await deleteProbeObject(`incoming/${id}`);

    return api.success({ recorded: true }, "Check recorded");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Check Error]", error);
    return api.internal();
  }
}

/** Remove the kilobyte a check wrote. Best effort, like every other cleanup on
 *  this path: the answer has already been given. */
async function deleteProbeObject(key: string): Promise<void> {
  try {
    const signed = signR2Request({ r2: config.r2, method: "DELETE", key, date: new Date() });
    await fetch(signed.url, {
      method: "DELETE",
      headers: signed.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.warn(
      `[Upload Check] could not remove ${key}: ${error instanceof Error ? error.name : "UnknownError"}`
    );
  }
}
