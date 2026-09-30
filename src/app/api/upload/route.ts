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
// Guardrails: auth required, 5 uploads / 5 min, images or .vtt captions.
// Size caps: images 10 MB (phone photos and HEIC files run large), captions 5 MB.
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
import { isHeifContainer } from "@/lib/image-bytes";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
  // WebVTT captions. Same route, same key shape, different bucket folder — a
  // creator should not need a second upload path to add subtitles to a scene.
  "text/vtt": ".vtt",
};

/**
 * A browser that has no opinion. These are the values a picker leaves behind
 * when it hands over a file it could not classify — which on Android is the
 * common case, not the edge one.
 */
const SAID_NOTHING = /^(|application\/octet-stream|binary\/octet-stream)$/;

/**
 * What a picture extension means, for a file the browser did not type.
 *
 * Deliberately the formats the pickers already OFFER (lib/media's
 * IMAGE_EXTENSIONS) and nothing more: an extension is a weaker signal than a
 * MIME type, so reading it buys back the files whose picker already promised
 * them, rather than widening what this route accepts.
 */
const UNTYPED_IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: ".jpg",
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  gif: ".gif",
  avif: ".avif",
  bmp: ".bmp",
  tif: ".tiff",
  tiff: ".tiff",
  heic: ".heic",
  heif: ".heif",
};

/**
 * The extension to store a file under, or null if it is not something we accept.
 *
 * Two of these formats are reached by FILENAME when the browser sends no usable
 * type, and both for the same reason: `file.type` is a claim the picker makes,
 * and on a phone the picker often makes no claim at all. A gallery photo, a
 * picture a chat app saved, anything the document provider has not indexed,
 * arrives as `""` or `application/octet-stream`.
 *
 * For captions that was always handled. For pictures it was not, and the result
 * was a creator's own cover refused by its own backend: lib/media's
 * `classifyFile` reads the extension in exactly this case, so the picker
 * accepted the photo, and this route answered "Only JPEG, PNG, WebP, HEIC or
 * HEIF images ... are allowed" about the same file. The two halves disagreed
 * about one picture, and the creator was told to choose an image while looking
 * at the image they had chosen.
 *
 * Nothing else about the rule moves: the stored extension is still this app's
 * own and never anything taken from the name, and what the BYTES are is checked
 * separately below — a HEIF container is refused under any name, and now under a
 * nameless type too.
 */
function extensionFor(file: File): string | null {
  const byType = ALLOWED_TYPES[file.type];
  if (byType) return byType;

  // Captions, unchanged: some browsers and every drag-and-drop from a file
  // manager hand a .vtt over with no type, or as plain text.
  if (
    /\.vtt$/i.test(file.name) &&
    /^(|application\/octet-stream|application\/x-subrip|text\/plain)$/.test(file.type)
  ) {
    return ".vtt";
  }

  if (SAID_NOTHING.test(file.type || "")) {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file.name.trim())?.[1].toLowerCase() ?? "";
    const stored = UNTYPED_IMAGE_EXTENSIONS[ext];
    if (stored) return stored;
  }

  return null;
}

// An avatar, a video cover or a KYC document all come straight off a phone, and
// a modern phone photo is routinely 4-8 MB before it is cropped. 10 MB is the
// ceiling that lets a real photo through while still bounding storage.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
// A WebVTT file is a list of timestamps — a feature-length scene is a few
// hundred KB. 5 MB is already far past anything real, so it stays.
const MAX_CAPTION_BYTES = 5 * 1024 * 1024; // 5 MB

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
        "Only picture files (JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC, HEIF) " +
          "or a .vtt captions file are allowed"
      );
    }
    const maxBytes = ext === ".vtt" ? MAX_CAPTION_BYTES : MAX_IMAGE_BYTES;
    if (file.size > maxBytes) {
      return api.validation(
        ext === ".vtt"
          ? "Captions file is too large (max 5 MB)"
          : "Image is too large (max 10 MB)"
      );
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

    // What the bytes are, not what the browser said. `file.type` decides only
    // the extension, so without this a HEIF container can be stored as a .png —
    // and this app hands its own public uploads to next/image's optimiser,
    // which decodes by CONTENT. Next 14 decodes AVIF through sharp/libheif, the
    // path with a critical unauthenticated RCE (GHSA-2xp9-vwfh-vxw4), so the
    // disguise was a route from a free account to code execution.
    //
    // An honest HEIC/HEIF photo is still accepted (phones produce them); it is
    // simply never optimised — see canOptimizeImage.
    // Declared by the type OR by the extension the route just resolved, because
    // those are now equally valid declarations — and a .HEIC from a photo
    // library with no MIME type is an honest HEIC, not a disguise. The check
    // below is about the BYTES either way.
    //
    // `.avif` is on this list for the same reason and not as a loophole: an
    // AVIF IS a HEIF container (`ftyp avif`), so without it every honest AVIF
    // was refused by the disguise check — the format was rejected by the very
    // rule meant to catch something pretending to be it. What the rule is for
    // is a HEIF wearing a name that is NOT a HEIF name, and that is unchanged.
    const declaredHeif = ext === ".heic" || ext === ".heif" || ext === ".avif";
    if (!declaredHeif && isHeifContainer(buffer)) {
      return api.validation(
        "That image could not be read — please upload a JPEG, PNG or WebP"
      );
    }

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
