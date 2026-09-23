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

import { createHash } from "node:crypto";
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

// 4) Optional signed TUS round trip (what creator uploads actually use)
//    Creates a video object, uploads a few bytes through the presigned TUS
//    endpoint, then deletes it — so the library is left exactly as it was.
//    Without this, a broken upload path can only be discovered by a creator
//    who has already lost their upload.
if (args.includes("--upload")) {
  const apiBase = "https://video.bunnycdn.com";
  let createdId = null;
  try {
    const created = await fetch(`${apiBase}/library/${libraryId}/videos`, {
      method: "POST",
      headers: { AccessKey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "genhub-tus-verify" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) throw new Error(`create video -> HTTP ${created.status}`);
    createdId = (await created.json()).guid;
    ok(`reserved a video slot (${createdId})`);

    const expirationTime = Math.floor(Date.now() / 1000) + 3600;
    const signature = createHash("sha256")
      .update(`${libraryId}${apiKey}${expirationTime}${createdId}`)
      .digest("hex");

    const payload = Buffer.from("genhub-tus-probe");
    const reserve = await fetch(`${apiBase}/tusupload`, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(payload.length),
        "Upload-Metadata": `filetype ${Buffer.from("video/mp4").toString("base64")},title ${Buffer.from("genhub-tus-verify").toString("base64")}`,
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expirationTime),
        LibraryId: libraryId,
        VideoId: createdId,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!reserve.ok) {
      throw new Error(`TUS reserve -> HTTP ${reserve.status} (${(await reserve.text()).slice(0, 120)})`);
    }
    const location = new URL(reserve.headers.get("location"), `${apiBase}/tusupload`).toString();
    ok("TUS upload authorized with the presigned signature");

    // Bunny needs the authorization on the PATCH as well, not only on reserve.
    const chunk = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
        AuthorizationSignature: signature,
        AuthorizationExpire: String(expirationTime),
        LibraryId: libraryId,
        VideoId: createdId,
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
    if (!chunk.ok) {
      throw new Error(
        `TUS PATCH -> HTTP ${chunk.status} (${(await chunk.text()).slice(0, 120)})`
      );
    }
    const written = chunk.headers.get("upload-offset");
    if (Number(written) === payload.length) {
      ok("bytes accepted — direct upload path works end to end");
    } else {
      fail(`TUS PATCH reported offset ${written}, expected ${payload.length}`);
      warnings++;
    }
  } catch (error) {
    fail(`TUS upload test failed: ${error.message || error}`);
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
