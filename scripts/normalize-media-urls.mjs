#!/usr/bin/env node
// =============================================================================
// GENHUB - Heal stored image URLs, and get identity documents out of the public
//          path they were written into
//
//   node scripts/normalize-media-urls.mjs            (report only)
//   node scripts/normalize-media-urls.mjs --apply    (write the changes)
//
// WHY
//
// Every image the app uploaded was stored as `https://<BUNNY_CDN_HOSTNAME>/<key>`.
// That hostname is the Stream library's pull zone; the files live in the storage
// zone. The two are different Bunny products, so every thumbnail, avatar and KYC
// photo answered 403 — no picture appeared anywhere, and an admin could not open
// the documents they were asked to approve.
//
// Images are now served by /api/media/<key>, and this script rewrites the rows
// that already exist so nothing keeps pointing at a dead URL.
//
// The KYC part is not cosmetic. Before this change the ID document and selfie
// were uploaded into the same `uploads/` prefix as public thumbnails, i.e. the
// exact path a pull zone would make world-readable. They are moved to
// `private/<userId>/kyc/<name>`, which the media route serves only to their owner
// and to admins. The move is copy -> verify -> update row -> delete original, so
// the object exists in the new place before the old one is removed.
//
// The script is idempotent: run it twice and the second run reports nothing to
// do. It never touches a URL it does not recognise (`mediaKeyFromUrl` refuses
// anything that is not ours), so an external link a creator pasted is left
// exactly as it is.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

const APPLY = process.argv.includes("--apply");
const STORAGE_ORIGIN = "https://storage.bunnycdn.com";

loadEnv();

const zone = (process.env.BUNNY_STORAGE_ZONE || "").trim();
const storageKey = (process.env.BUNNY_STORAGE_ACCESS_KEY || "").trim();
const cdnHostname = (process.env.BUNNY_CDN_HOSTNAME || "").trim();

console.log("\n=== media URL normalisation ===\n");
console.log(`mode: ${APPLY ? "APPLY (writes)" : "report only (pass --apply to write)"}`);
if (!cdnHostname) warn("BUNNY_CDN_HOSTNAME is not set — legacy CDN URLs cannot be recognised");

// -----------------------------------------------------------------------------
// Key rules — a copy of src/lib/media.ts, deliberately kept tiny and WITHOUT the
// "private/" special cases. These are the rules needed to recognise and move a
// legacy key; any drift from the TypeScript version is caught by the assertion at
// the end of this block (the shapes are the same for the keys that exist here).
// -----------------------------------------------------------------------------
const PREFIX = "/api/media/";

function isSafeMediaKey(key) {
  if (!key || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("\\") || key.includes("?")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  return key.split("/").every((s) => s && s !== "." && s !== "..");
}

function mediaKeyFromUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (raw.startsWith(PREFIX)) {
    const key = decodeURIComponent(raw.slice(PREFIX.length));
    return isSafeMediaKey(key) ? key : null;
  }
  if (raw.startsWith("/uploads/")) {
    const key = decodeURIComponent(raw.slice(1));
    return isSafeMediaKey(key) ? key : null;
  }
  if (!/^https?:\/\//i.test(raw)) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isBunny = url.hostname === cdnHostname || url.hostname.endsWith(".b-cdn.net");
  if (!isBunny) return null;
  const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return isSafeMediaKey(key) ? key : null;
}

const mediaUrlFor = (key) => `${PREFIX}${key}`;

// A key that already lives in the private bucket needs nothing.
const alreadyPrivate = (url) => {
  const key = mediaKeyFromUrl(url);
  return Boolean(key && key.startsWith("private/"));
};

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------
async function storageGet(key) {
  const res = await fetch(`${STORAGE_ORIGIN}/${zone}/${key}`, {
    headers: { AccessKey: storageKey },
  });
  if (!res.ok) throw new Error(`storage GET ${key} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function storagePut(key, body, contentType) {
  const res = await fetch(`${STORAGE_ORIGIN}/${zone}/${key}`, {
    method: "PUT",
    headers: { AccessKey: storageKey, "Content-Type": contentType || "application/octet-stream" },
    body,
  });
  if (!res.ok) throw new Error(`storage PUT ${key} -> ${res.status}`);
}

async function storageDelete(key) {
  const res = await fetch(`${STORAGE_ORIGIN}/${zone}/${key}`, {
    method: "DELETE",
    headers: { AccessKey: storageKey },
  });
  if (!res.ok && res.status !== 404) throw new Error(`storage DELETE ${key} -> ${res.status}`);
}

const contentTypeFor = (key) => {
  const ext = key.split(".").pop()?.toLowerCase();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    }[ext] || "application/octet-stream"
  );
};

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const summary = { rewritten: 0, moved: 0, untouched: 0, failed: 0 };

/** Rewrite one column when it holds a legacy CDN URL. */
async function heal({ model, label, where, current, update }) {
  if (!current) return;
  const key = mediaKeyFromUrl(current);
  if (!key) {
    summary.untouched++;
    console.log(`  · ${label}: not ours, left alone (${String(current).slice(0, 70)})`);
    return;
  }
  const next = mediaUrlFor(key);
  if (next === current) {
    summary.untouched++;
    return;
  }
  console.log(`  → ${label}\n      ${current}\n      ${next}`);
  if (!APPLY) return;
  try {
    await prisma[model].update({ where, data: update(next) });
    summary.rewritten++;
  } catch (error) {
    summary.failed++;
    fail(`${label}: ${error.message}`);
  }
}

async function moveKycDocument({ id, userId, label, current }) {
  if (!current || alreadyPrivate(current)) return;
  const key = mediaKeyFromUrl(current);
  if (!key) {
    summary.untouched++;
    console.log(`  · ${label}: not ours, left alone (${String(current).slice(0, 70)})`);
    return;
  }

  const name = key.split("/").pop();
  const dest = `private/${userId}/kyc/${name}`;
  console.log(`  → ${label}\n      ${current}\n      ${mediaUrlFor(dest)}`);

  if (!APPLY) return;
  try {
    const body = await storageGet(key);
    await storagePut(dest, body, contentTypeFor(dest));
    // Verify before the original goes away — a half-done move that deletes the
    // only copy of somebody's ID would be unrecoverable.
    const check = await storageGet(dest);
    if (check.length !== body.length) {
      throw new Error(`copy length mismatch (${check.length} != ${body.length})`);
    }
    await prisma.kycVerification.update({
      where: { id },
      data: { [label === "idDocumentUrl" ? "idDocumentUrl" : "selfieUrl"]: mediaUrlFor(dest) },
    });
    await storageDelete(key);
    summary.moved++;
  } catch (error) {
    summary.failed++;
    fail(`${label} (${id}): ${error.message}`);
  }
}

try {
  // ---- Public images ---------------------------------------------------------
  console.log("public images:");

  for (const video of await prisma.video.findMany({
    select: { id: true, title: true, thumbnailUrl: true },
  })) {
    await heal({
      model: "video",
      label: `video thumbnail "${video.title}"`,
      where: { id: video.id },
      current: video.thumbnailUrl,
      update: (url) => ({ thumbnailUrl: url }),
    });
  }

  for (const user of await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { id: true, displayName: true, avatarUrl: true },
  })) {
    await heal({
      model: "user",
      label: `avatar "${user.displayName}"`,
      where: { id: user.id },
      current: user.avatarUrl,
      update: (url) => ({ avatarUrl: url }),
    });
  }

  for (const profile of await prisma.creatorProfile.findMany({
    where: { coverImageUrl: { not: null } },
    select: { id: true, coverImageUrl: true },
  })) {
    await heal({
      model: "creatorProfile",
      label: `creator cover ${profile.id}`,
      where: { id: profile.id },
      current: profile.coverImageUrl,
      update: (url) => ({ coverImageUrl: url }),
    });
  }

  for (const image of await prisma.galleryImage.findMany({
    select: { id: true, url: true },
  })) {
    await heal({
      model: "galleryImage",
      label: `gallery image ${image.id}`,
      where: { id: image.id },
      current: image.url,
      update: (url) => ({ url }),
    });
  }

  // ---- Identity documents ----------------------------------------------------
  console.log("\nidentity documents (moved to the owner-only bucket):");

  if (!zone || !storageKey) {
    warn("BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY not set — KYC move skipped");
  } else {
    const rows = await prisma.kycVerification.findMany({
      select: { id: true, userId: true, idDocumentUrl: true, selfieUrl: true },
    });
    if (rows.length === 0) console.log("  · no KYC submissions");
    for (const row of rows) {
      await moveKycDocument({
        id: row.id,
        userId: row.userId,
        label: "idDocumentUrl",
        current: row.idDocumentUrl,
      });
      await moveKycDocument({
        id: row.id,
        userId: row.userId,
        label: "selfieUrl",
        current: row.selfieUrl,
      });
    }
  }

  console.log("\n---");
  console.log(
    `rewritten ${summary.rewritten} · moved ${summary.moved} · ` +
      `already fine ${summary.untouched} · failed ${summary.failed}`
  );
  if (!APPLY) {
    console.log("\nNothing was written. Re-run with --apply to make these changes.");
  } else if (summary.failed === 0) {
    ok("done");
  }
  process.exitCode = summary.failed > 0 ? 1 : 0;
} catch (error) {
  fail(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
