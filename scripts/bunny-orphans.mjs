#!/usr/bin/env node
// =============================================================================
// GENHUB - Videos on Bunny Stream with no row in the database
//
// Run:  node scripts/bunny-orphans.mjs        -> report only (nothing is deleted)
//       node scripts/bunny-orphans.mjs --yes  -> delete them from the library
//
// The database row is the record; the Bunny asset is the bytes. When a video row
// is deleted — a launch clean, a creator taking a scene down — the asset stays
// behind, because nothing tells Bunny about a Postgres delete. It keeps counting
// against the library, and it is invisible: the admin panel lists rows, so an
// orphan appears on no screen at all.
//
// The match is `Video.bunnyVideoId`. A video mid-upload has a row before its
// asset exists, which is the safe direction: a row without an asset is a broken
// upload somebody can see and retry, while an asset without a row is money being
// paid for nothing.
//
// It is a dry run unless you pass --yes, and it prints the title of everything
// it would remove: the one asset worth keeping out of this net is a clip that
// belongs to the app rather than to a video row (an intro, a promo), and that
// decision is a person's, not a script's.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const execute = process.argv.includes("--yes");
const env = (k) => (process.env[k] || "").trim();

const apiKey = env("BUNNY_STREAM_API_KEY");
const libraryId = env("BUNNY_STREAM_LIBRARY_ID");

console.log("\n=== GENHUB Bunny orphans ===\n");

if (!apiKey || !libraryId) {
  fail("BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID are not set (.env.local)");
  process.exit(1);
}

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const PAGE_SIZE = 100;

try {
  // ---------------------------------------------------------------------------
  // 1. Everything in the library
  // ---------------------------------------------------------------------------
  const assets = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${libraryId}/videos?page=${page}&itemsPerPage=${PAGE_SIZE}&orderBy=date`,
      { headers: { AccessKey: apiKey }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) {
      fail(`listing the library failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      process.exitCode = 1;
      break;
    }
    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    assets.push(...items);
    if (items.length < PAGE_SIZE) break;
  }

  // ---------------------------------------------------------------------------
  // 2. Everything the database claims
  // ---------------------------------------------------------------------------
  const rows = await prisma.video.findMany({ select: { bunnyVideoId: true, title: true } });
  const known = new Set(rows.map((r) => r.bunnyVideoId).filter(Boolean));

  const orphans = assets.filter((a) => !known.has(a.guid));

  console.log(`  Library assets : ${assets.length}`);
  console.log(`  Database rows  : ${rows.length}`);
  console.log(`  Orphans        : ${orphans.length}\n`);

  if (orphans.length === 0) {
    ok("every asset in the library belongs to a video row");
    console.log("");
    process.exit(0);
  }

  for (const a of orphans) {
    const mb = ((a.storageSize || 0) / 1024 / 1024).toFixed(1);
    const created = a.dateUploaded ? new Date(a.dateUploaded).toISOString().slice(0, 10) : "—";
    console.log(
      `      ${a.guid}  ${String(a.status ?? "?").padEnd(4)} ${created}  ${mb.padStart(7)} MB  ` +
        `${(a.title || "—").slice(0, 60)}`
    );
  }
  console.log("");

  if (!execute) {
    const mb = (orphans.reduce((s, a) => s + (a.storageSize || 0), 0) / 1024 / 1024).toFixed(1);
    console.log(`  Dry run — nothing will be deleted. ${mb} MB would be freed.\n`);
    console.log("  Check the titles above before removing them: an asset that belongs to");
    console.log("  the app rather than to a video row (an intro clip, a promo) would show");
    console.log("  up here too. Re-run with --yes to delete.\n");
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 3. Delete
  // ---------------------------------------------------------------------------
  let removed = 0;
  let failed = 0;
  for (const a of orphans) {
    const res = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${a.guid}`, {
      method: "DELETE",
      headers: { AccessKey: apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) removed += 1;
    else {
      failed += 1;
      warn(`could not delete ${a.guid} ("${a.title}"): HTTP ${res.status}`);
    }
  }

  console.log(`\n  Deleted ${removed} asset(s)${failed ? `, ${failed} failed` : ""}.\n`);

  // Prove it rather than trusting the loop: re-list and count again.
  const after = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${libraryId}/videos?page=${page}&itemsPerPage=${PAGE_SIZE}`,
      { headers: { AccessKey: apiKey }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) break;
    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    after.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  const left = after.filter((a) => !known.has(a.guid));
  if (left.length === 0) ok("verified: no orphaned assets remain");
  else {
    fail(`${left.length} orphan(s) survived`);
    process.exitCode = 1;
  }
} catch (error) {
  fail(error.message || String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
