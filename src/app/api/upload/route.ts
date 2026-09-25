// =============================================================================
// GENHUB - Image Upload API Route
// POST /api/upload (multipart/form-data, field name "file")
// Used by the KYC form (ID + selfie) and the creator thumbnail picker so real
// users never have to host an image somewhere and paste a URL.
//
// Storage order:
//   1. Bunny.net Storage  — when BUNNY_STORAGE_ZONE/ACCESS_KEY are configured
//      (production path; survives redeploys)
//   2. Local public/uploads — dev and self-hosted servers only. On read-only
//      hosts (Vercel) the route returns 503 instead of silently losing files.
//
// The returned URL is always OUR OWN route (`/api/media/<key>`), never a Bunny
// hostname. Handing out `https://${BUNNY_CDN_HOSTNAME}/${key}` is what made every
// upload invisible: that hostname is the Stream library's pull zone, which does
// not serve storage-zone objects, so each image answered 403. See lib/media.ts.
//
// `kind` decides the key's first segment and therefore who can read it back:
//   public  (default) — thumbnails, avatars, gallery photos
//   private           — KYC documents, readable only by their owner and admins
//
// Guardrails: auth required, 5 uploads / 5 min, images or .vtt captions, 5 MB.
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
import { mediaUrlFor, type MediaKind } from "@/lib/media";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  // WebVTT captions. Same route, same key shape, different bucket folder — a
  // creator should not need a second upload path to add subtitles to a scene.
  "text/vtt": ".vtt",
};

/**
 * The extension to store a file under, or null if it is not something we accept.
 *
 * `.vtt` is also accepted from the FILENAME when the browser sends no type. Some
 * browsers (and every drag-and-drop from a file manager) hand over an empty or
 * `application/octet-stream` type for a caption file, and refusing those would
 * make the feature work on one machine and not the next. Nothing else about the
 * rule moves: the stored extension is still the app's own, and the file still
 * has to be named .vtt.
 */
function extensionFor(file: File): string | null {
  const byType = ALLOWED_TYPES[file.type];
  if (byType) return byType;
  if (/\.vtt$/i.test(file.name) && /^(|application\/octet-stream|application\/x-subrip|text\/plain)$/.test(file.type)) {
    return ".vtt";
  }
  return null;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Which bucket a key lands in. Anything else is refused rather than guessed: a
 * typo silently writing an ID document into the public bucket is the one mistake
 * this route must not be able to make.
 */
function parseKind(value: FormDataEntryValue | null): MediaKind | null {
  if (value === null || value === "" || value === "public") return "public";
  if (value === "private") return "private";
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const { allowed } = await checkRateLimit(
      `upload:${auth.userId}`,
      config.rateLimit.upload.max,
      config.rateLimit.upload.windowMs
    );
    if (!allowed) {
      return api.rateLimited("Too many uploads — wait a few minutes.");
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return api.validation('Send multipart form-data with field "file"');
    }
    const ext = extensionFor(file);
    if (!ext) {
      return api.validation(
        "Only JPEG, PNG, WebP, HEIC or HEIF images, or a .vtt captions file, are allowed"
      );
    }
    if (file.size > MAX_BYTES) {
      return api.validation("File is too large (max 5 MB)");
    }

    const kind = parseKind(form?.get("kind") ?? null);
    if (!kind) {
      return api.validation('kind must be "public" or "private"');
    }

    // Captions cannot be private: the <track> element fetches them as the
    // browser, with no way to attach a session, so a private file would be
    // invisible to every viewer while looking perfectly uploaded to the creator.
    if (ext === ".vtt" && kind !== "public") {
      return api.validation("Captions must be uploaded as public");
    }

    const stamp = new Date().toISOString().slice(0, 7); // yyyy-mm
    const name = `${randomBytes(10).toString("hex")}${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    // 1) Bunny storage (production)
    const { storageZone, storageAccessKey } = config.bunny;
    if (storageZone && storageAccessKey) {
      // The owner id is IN the private key so the media route can authorise a
      // read from the path alone, without depending on a database row existing.
      const key =
        kind === "private"
          ? `private/${auth.userId}/${stamp}/${name}`
          : ext === ".vtt"
            ? `public/captions/${stamp}/${name}`
            : `public/images/${stamp}/${name}`;
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
        { url: mediaUrlFor(key), storage: "bunny", kind },
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

    // Local dev keeps the same key shape (public/... vs private/...) so a
    // developer never gets a different access rule than production.
    //
    // The two kinds land in different directories on purpose: Next serves
    // `public/` statically, and a private key sitting in there would be readable
    // by anyone at /uploads/private/... regardless of the session. Private files
    // go to `.media/`, which is outside the static tree and only reachable
    // through the media route.
    const key =
      kind === "private"
        ? `private/${auth.userId}/${stamp}/${name}`
        : ext === ".vtt"
          ? `public/captions/${stamp}/${name}`
          : `public/images/${stamp}/${name}`;
    const root = kind === "private" ? ".media" : path.join("public", "uploads");
    const filePath = path.join(process.cwd(), root, key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);

    return api.success(
      { url: mediaUrlFor(key), storage: "local", kind },
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
