#!/usr/bin/env node
// Verify the Bunny Stream credentials and the exact direct TUS upload path.
// Run: node scripts/verify-bunny.mjs [--upload] [--storage]

import { createHash } from "node:crypto";
import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();
const env = (key) => (process.env[key] || "").trim();
const apiKey = env("BUNNY_STREAM_API_KEY");
const libraryId = env("BUNNY_STREAM_LIBRARY_ID");
const cdnHostname = env("BUNNY_CDN_HOSTNAME");
const storageZone = env("BUNNY_STORAGE_ZONE");
const storageKey = env("BUNNY_STORAGE_ACCESS_KEY");
const API = "https://video.bunnycdn.com";
const TUS = `${API}/tusupload`;
const TUS_VERSION = "1.0.0";
let warnings = 0;

console.log("\n=== Bunny.net verification ===\n");
if (!apiKey || !libraryId) {
  fail("BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID not configured");
  process.exit(1);
}

try {
  const response = await fetch(`${API}/library/${libraryId}`, {
    headers: { AccessKey: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  ok(`Stream API valid - library "${body.name || libraryId}"`);
} catch (error) {
  fail(`Stream API check failed: ${error.message || error}`);
  process.exit(1);
}

if (cdnHostname) ok(`CDN hostname: ${cdnHostname}`);
else {
  warn("BUNNY_CDN_HOSTNAME is empty - signed playback will not work");
  warnings++;
}

if (process.argv.includes("--storage")) {
  if (!storageZone || !storageKey) {
    fail("BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY not set");
    warnings++;
  } else {
    const url = `https://storage.bunnycdn.com/${storageZone}/genhub-ping.txt`;
    try {
      const put = await fetch(url, {
        method: "PUT",
        headers: { AccessKey: storageKey, "Content-Type": "text/plain" },
        body: "ping",
        signal: AbortSignal.timeout(15_000),
      });
      if (!put.ok) throw new Error(`PUT HTTP ${put.status}`);
      ok("Storage zone write access confirmed");
      const del = await fetch(url, { method: "DELETE", headers: { AccessKey: storageKey } });
      if (del.ok) ok("Storage probe deleted");
    } catch (error) {
      fail(`Storage test failed: ${error.message || error}`);
      warnings++;
    }
  }
}

if (process.argv.includes("--upload")) {
  let videoId = null;
  let uploadUrl = null;
  const total = 4;
  const bytes = new Uint8Array([0x47, 0x65, 0x6e, 0x68]);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const sign = (id) => createHash("sha256").update(`${libraryId}${apiKey}${expires}${id}`).digest("hex");
  const headersFor = (id) => ({
    AuthorizationSignature: sign(id),
    AuthorizationExpire: String(expires),
    LibraryId: libraryId,
    VideoId: id,
    "Tus-Resumable": TUS_VERSION,
  });

  try {
    const created = await fetch(`${API}/library/${libraryId}/videos`, {
      method: "POST",
      headers: { AccessKey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "genhub-upload-verify" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) throw new Error(`create video HTTP ${created.status}`);
    videoId = (await created.json()).guid;
    const opened = await fetch(TUS, {
      method: "POST",
      headers: {
        ...headersFor(videoId),
        "Upload-Length": String(total),
        "Upload-Metadata": `filetype ${Buffer.from("video/mp4").toString("base64")},title ${Buffer.from(videoId).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!opened.ok) throw new Error(`open TUS HTTP ${opened.status}`);
    const location = opened.headers.get("location");
    if (!location) throw new Error("Bunny returned no TUS location");
    uploadUrl = new URL(location, API).toString();

    const patched = await fetch(uploadUrl, {
      method: "PATCH",
      headers: { ...headersFor(videoId), "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
      body: bytes,
      signal: AbortSignal.timeout(15_000),
    });
    if (!patched.ok) throw new Error(`PATCH HTTP ${patched.status}`);
    const offset = Number(patched.headers.get("upload-offset"));
    if (offset !== total) throw new Error(`Bunny acknowledged offset ${offset}, expected ${total}`);
    ok("Direct Bunny TUS upload round trip confirmed");
  } catch (error) {
    fail(`Direct upload test failed: ${error.message || error}`);
    warnings++;
  } finally {
    if (uploadUrl) await fetch(uploadUrl, { method: "DELETE", headers: headersFor(videoId) }).catch(() => undefined);
    if (videoId) {
      const deleted = await fetch(`${API}/library/${libraryId}/videos/${videoId}`, {
        method: "DELETE",
        headers: { AccessKey: apiKey },
      });
      if (deleted.ok) ok("Probe video deleted - library unchanged");
      else warn(`Could not delete probe video ${videoId}`);
    }
  }
}

console.log(`\n${warnings === 0 ? "Bunny.net looks ready." : `${warnings} warning(s).`}\n`);
process.exit(warnings > 0 ? 1 : 0);
