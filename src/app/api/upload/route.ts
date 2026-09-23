// =============================================================================
// GENHUB - Image Upload API Route
// POST /api/upload (multipart/form-data, field name "file")
// Used by the KYC form (ID + selfie) and the creator thumbnail picker so real
// users never have to host an image somewhere and paste a URL.
//
// Storage order:
//   1. Bunny.net Storage  — when BUNNY_STORAGE_ZONE/ACCESS_KEY/CDN_HOSTNAME
//      are configured (production path; survives redeploys)
//   2. Local public/uploads — dev and self-hosted servers only. On read-only
//      hosts (Vercel) the route returns 503 instead of silently losing files.
//
// Guardrails: auth required, 5 uploads / 5 min, images only, 5 MB max.
// =============================================================================

import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const { allowed } = await checkRateLimit(
      `upload:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Images too many — wait a few minutes.");
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return api.validation('Send multipart form-data with field "file"');
    }
    if (!ALLOWED_TYPES[file.type]) {
      return api.validation("Only JPEG, PNG, WebP, HEIC or HEIF images are allowed");
    }
    if (file.size > MAX_BYTES) {
      return api.validation("Image is too large (max 5 MB)");
    }

    const ext = ALLOWED_TYPES[file.type];
    const stamp = new Date().toISOString().slice(0, 7); // yyyy-mm
    const name = `${randomBytes(10).toString("hex")}${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    // 1) Bunny storage (production)
    const { storageZone, storageAccessKey, cdnHostname } = config.bunny;
    if (storageZone && storageAccessKey && cdnHostname) {
      const key = `uploads/${stamp}/${name}`;
      const res = await fetch(
        `https://storage.bunnycdn.com/${storageZone}/${key}`,
        {
          method: "PUT",
          headers: {
            AccessKey: storageAccessKey,
            "Content-Type": file.type,
          },
          body: buffer,
          signal: AbortSignal.timeout(30_000),
        }
      );
      if (!res.ok) {
        console.error(`[Upload] Bunny storage error ${res.status}`);
        return api.error("Image upload failed — try again", 502, "STORAGE_ERROR");
      }
      return api.success(
        { url: `https://${cdnHostname}/${key}`, storage: "bunny" },
        "Image uploaded"
      );
    }

    // 2) Local disk (dev / self-hosted). Refuse where it cannot persist.
    if (config.nodeEnv === "production") {
      return api.error(
        "Image storage is not configured — set BUNNY_STORAGE_* credentials",
        503,
        "STORAGE_NOT_CONFIGURED"
      );
    }

    const dir = path.join(process.cwd(), "public", "uploads", stamp);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buffer);

    return api.success(
      { url: `/uploads/${stamp}/${name}`, storage: "local" },
      "Image uploaded"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403
        ? api.forbidden(error.message)
        : api.unauthorized(error.message);
    }
    console.error("[Upload Error]", error);
    return api.internal();
  }
}
