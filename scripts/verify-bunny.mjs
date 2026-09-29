#!/usr/bin/env node
// =============================================================================
// GENHUB - Bunny.net integration verification
// Run:  node scripts/verify-bunny.mjs
//         -> READ-ONLY library lookup (validates BUNNY_STREAM_API_KEY +
//            BUNNY_STREAM_LIBRARY_ID)
//       node scripts/verify-bunny.mjs --storage
//         -> also PUTs a 4-byte ping file into the storage zone and deletes
//            it (validates BUNNY_STORAGE_ACCESS_KEY)
//
// Placeholders in .env.local will fail here until real credentials exist.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const args = process.argv.slice(2);
const env = (k) => (process.env[k] || "").trim();

const apiKey = env("BUNNY_STREAM_API_KEY");
const libraryId = env("BUNNY_STREAM_LIBRARY_ID");
const cdnHostname = env("BUNNY_CDN_HOSTNAME");
const storageZone = env("BUNNY_STORAGE_ZONE");
const storageKey = env("BUNNY_STORAGE_ACCESS_KEY");

let warnings = 0;
console.log("\n=== Bunny.net verification ===\n");

if (!apiKey || !libraryId) {
  fail("BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID not configured in .env.local");
  console.log(
    "   Create a Stream library at https://bunny.net → Account → API keys, then fill .env.local.\n"
  );
  process.exit(1);
}

// 1) Stream API — read-only library lookup
try {
  const res = await fetch(`https://video.bunnycdn.com/library/${libraryId}`, {
    headers: { AccessKey: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`library lookup -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    if (res.status === 401 || res.status === 403) {
      console.log("   API key is wrong or lacks access to this library.");
    }
    process.exit(1);
  }
  ok(
    `API key valid — library "${body.name || libraryId}" (plan: ${body.plan ?? "?"}, videos: ${body.totalVideos ?? body.videoCount ?? "?"})`
  );
} catch (error) {
  fail(`could not reach Bunny.net: ${error.message || error}`);
  process.exit(1);
}

// 2) CDN hostname (needed for signed HLS playback)
if (cdnHostname) {
  ok(`CDN hostname: ${cdnHostname}`);
} else {
  warn("BUNNY_CDN_HOSTNAME empty — signed playback URLs will not work");
  warnings++;
}

// 3) Optional storage-zone round trip (thumbnails use this)
if (args.includes("--storage")) {
  if (!storageZone || !storageKey) {
    fail("BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY not set — skipping storage test");
    warnings++;
  } else {
    const path = `https://storage.bunnycdn.com/${storageZone}/genhub-ping.txt`;
    try {
      const put = await fetch(path, {
        method: "PUT",
        headers: { AccessKey: storageKey, "Content-Type": "text/plain" },
        body: "ping",
        signal: AbortSignal.timeout(15_000),
      });
      if (!put.ok) {
        fail(`storage PUT -> HTTP ${put.status} (check storage zone name + access key)`);
        warnings++;
      } else {
        ok("storage zone write access confirmed");
        const del = await fetch(path, {
          method: "DELETE",
          headers: { AccessKey: storageKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (del.ok) ok("ping file cleaned up");
      }
    } catch (error) {
      fail(`storage test failed: ${error.message || error}`);
      warnings++;
    }
  }
} else {
  console.log("   (add --storage to also test thumbnail storage upload)");
}

// 4) Optional upload-path check.
//    A creator's file no longer goes to Bunny from the browser at all: it goes
//    to an R2 bucket with a presigned URL, and worker/video-ingest moves it into
//    the slot reserved here. So this checks the two halves a script can check —
//    that the library accepts a new slot, and that the ingest Worker is up and
//    configured — and deletes the slot afterwards.
//
//    The presigned signature itself is deliberately NOT re-derived here. It is
//    checked by the application's own tests against AWS's published vector, and
//    a second implementation in a script is exactly how two copies of a signing
//    rule start to drift — which is the bug this codebase has already paid for.
if (args.includes("--upload")) {
  const apiBase = "https://video.bunnycdn.com";
  let createdId = null;
  try {
    const created = await fetch(`${apiBase}/library/${libraryId}/videos`, {
      method: "POST",
      headers: { AccessKey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "genhub-upload-verify" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) throw new Error(`create video -> HTTP ${created.status}`);
    createdId = (await created.json()).guid;
    ok(`reserved a video slot (${createdId})`);

    const ingestUrl = (process.env.VIDEO_INGEST_URL || "").trim();
    if (!ingestUrl) {
      console.log("   (set VIDEO_INGEST_URL to also check the ingest Worker)");
    } else {
      const health = await fetch(new URL("/health", ingestUrl), {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await health.json().catch(() => ({}));
      if (!health.ok || !body.ok) {
        throw new Error(`ingest health -> HTTP ${health.status}`);
      }
      if (!body.bucketConfigured || !body.secretConfigured || !body.bunnyConfigured) {
        throw new Error(`the ingest Worker is missing configuration: ${JSON.stringify(body)}`);
      }
      ok("the ingest Worker is up, with its bucket, its secret and the library key");
    }
  } catch (error) {
    fail(`upload path check failed: ${error.message || error}`);
    warnings++;
  } finally {
    if (createdId) {
      const del = await fetch(`${apiBase}/library/${libraryId}/videos/${createdId}`, {
        method: "DELETE",
        headers: { AccessKey: apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (del.ok) ok("probe video deleted — library unchanged");
      else warn(`could not delete probe video ${createdId}`);
    }
  }
} else {
  console.log("   (add --upload to also test a real signed upload round trip)");
}

console.log(`\n${warnings === 0 ? "Bunny.net looks ready." : `${warnings} warning(s).`}\n`);
process.exit(warnings > 0 ? 1 : 0);
