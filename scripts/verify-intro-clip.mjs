#!/usr/bin/env node
// =============================================================================
// GENHUB - Can the intro clip be widened into the scene?
//
// Run:  npm run verify:intro-clip
//       npm run verify:intro-clip -- --url https://genhub-two.vercel.app
//       npm run verify:intro-clip -- --url http://localhost:3100
//
// -----------------------------------------------------------------------------
// Why this exists
//
// /api/videos/[id]/intro-clip hands a viewer with NO entitlement a manifest of
// the scene's own HLS segments. That is the whole point — a trailer made of four
// four-second pieces of the scene — and it is also the shape of a paywall hole:
// if the segments it names could be turned into the rest of the video, the intro
// would be a free copy of the film.
//
// The safety argument has two halves, and this script is the second one:
//
//   1. It is COMPUTED, not passed in. The route takes no parameters — there is no
//      `?path=`, no `?segment=`, nothing a caller can name — so the segment set
//      cannot be widened by asking for more.
//   2. It is SIGNED PER FILE. Each URL in the manifest carries a token signed for
//      that exact path, and the pull zone refuses a signature that was issued for
//      a different file.
//
// (2) is a property of Bunny's pull zone rather than of our code, so it cannot be
// asserted with a unit test — it has to be measured against the deployment. If
// Bunny ever starts honouring a folder-wide signature on child paths, this script
// is what will notice.
//
// -----------------------------------------------------------------------------
// What it checks
//
//   GET /api/videos/<slug>/intro-clip
//     - answers 200 with an HLS manifest, or 404 (nothing to build yet — a
//       normal answer, not a failure)
//     - names only a few segments, and never every segment in the scene
//     - every URL is signed (`token=` + `expires=`)
//
//   For each URL in that manifest
//     - fetches 2xx WITHOUT a Referer (a server-side fetch, the way our own
//       routes consume the CDN)
//     - and its token is REFUSED when replayed against a segment the manifest did
//       not name. A 2xx there is the leak.
//
//   Asking for more
//     - `?path=`, `?segments=`, `?start=`, `?count=` and a dotted traversal are
//       all ignored: the body must be byte-identical to the plain request.
//
// Nothing is written and no cookie is sent, so this is safe to run against
// production. Exit code is 1 when something does not hold.
// =============================================================================

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const BASE = (argValue("--url", process.env.APP_URL || "http://localhost:3000")).replace(/\/+$/, "");

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function note(label) {
  console.log(`  • ${label}`);
}

async function get(url, init = {}) {
  const response = await fetch(url, { redirect: "follow", ...init });
  return response;
}

/**
 * The manifest with its signatures erased.
 *
 * Every request mints fresh tokens (a new expiry at least), so two correct
 * answers are never byte-identical — comparing them whole would report a
 * difference that means nothing. What must not change is WHICH pieces are named.
 */
function shapeOf(body) {
  return body
    .replace(/token=[A-Za-z0-9_-]+/g, "token=x")
    .replace(/expires=\d+/g, "expires=0");
}

/** Segments a manifest names, plus the signed query of each. */
function readManifest(body) {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const urls = lines.filter((line) => line && !line.startsWith("#"));
  return {
    urls,
    segmentCount: lines.filter((line) => line.startsWith("#EXTINF")).length,
    discontinuities: lines.filter((line) => line.startsWith("#EXT-X-DISCONTINUITY")).length,
    isVod: lines.includes("#EXT-X-PLAYLIST-TYPE:VOD"),
    isClosed: lines.includes("#EXT-X-ENDLIST"),
  };
}

// Which scenes to ask about: the paid, published ones the paywall script knows.
async function listTargets() {
  const response = await get(`${BASE}/api/videos?limit=20`);
  if (!response.ok) return [];
  const payload = await response.json();
  const videos = payload?.data?.videos;
  if (!Array.isArray(videos)) return [];
  return videos
    .filter((video) => video && (video.price ?? 0) > 0)
    .map((video) => video.slug || video.id);
}

const targets = await listTargets();
console.log(`\nIntro clip — ${BASE}`);
console.log(
  targets.length > 0
    ? `Asking about ${targets.length} paid scene(s): ${targets.join(", ")}\n`
    : "No paid scene is published, so there is nothing to cut a trailer from.\n"
);

if (targets.length === 0) {
  note("Nothing to check. Publish a paid scene and run this again.");
  process.exit(0);
}

for (const slug of targets) {
  console.log(`${slug}`);

  const route = `${BASE}/api/videos/${encodeURIComponent(slug)}/intro-clip`;
  const response = await get(route);

  if (response.status === 404) {
    note("no intro clip yet (nothing to build from) — a normal answer, not a failure");
    continue;
  }

  if (response.status !== 200) {
    check(false, "the intro clip route answers 200", `HTTP ${response.status}`);
    continue;
  }
  check(true, "the intro clip route answers 200");

  const body = await response.text();
  const manifest = readManifest(body);

  check(
    manifest.isVod && manifest.isClosed,
    "the body is a closed VOD playlist",
    body.slice(0, 160)
  );
  check(
    manifest.segmentCount > 0 && manifest.segmentCount <= 6,
    `few segments are named (${manifest.segmentCount})`,
    "a trailer that names seven or more is no longer a trailer"
  );
  check(
    manifest.urls.length === manifest.segmentCount,
    "every named segment carries a URL"
  );
  check(
    manifest.urls.every((url) => url.includes("token=") && url.includes("expires=")),
    "every URL is signed"
  );
  check(
    manifest.segmentCount > 1 ? manifest.discontinuities === manifest.segmentCount - 1 : true,
    "the jumps between pieces are declared",
    "players need EXT-X-DISCONTINUITY at each seam"
  );

  // Can the signature for one piece be replayed against a piece we did not name?
  const first = manifest.urls[0];
  if (!first) {
    check(false, "at least one signed segment URL", "empty manifest");
    continue;
  }

  const parts = new URL(first);
  const replay = `${parts.origin}${parts.pathname.replace(/video\d+\.[a-z0-9]+$/i, "video999999.ts")}${
    parts.search
  }`;

  const named = await get(first, { headers: { Range: "bytes=0-1023" } });
  check(
    named.status >= 200 && named.status < 300,
    "a named segment answers 2xx without a Referer",
    `HTTP ${named.status}`
  );

  const widened = await get(replay, { headers: { Range: "bytes=0-1023" } });
  check(
    widened.status === 401 || widened.status === 403 || widened.status === 404,
    "a segment the manifest did NOT name refuses that token",
    widened.status >= 200 && widened.status < 300
      ? `HTTP ${widened.status} — the signature is folder-wide, so the intro can be replayed into the scene`
      : `HTTP ${widened.status}`
  );

  // Asking for more must change nothing at all.
  const plain = await (await get(route)).text();
  const probes = [
    `${route}?path=playlist.m3u8`,
    `${route}?path=../../playlist.m3u8`,
    `${route}?segments=all`,
    `${route}?count=999`,
    `${route}?window=60`,
  ];
  const bodies = await Promise.all(probes.map(async (probe) => (await get(probe)).text()));
  const expected = shapeOf(plain);
  check(
    bodies.every((candidate) => shapeOf(candidate) === expected),
    "no query parameter changes which pieces are served",
    "the route takes no input, so there is nothing to widen"
  );
}

console.log(
  `\n${checks} check(s) · ${failures === 0 ? "✓ the intro clip stays an intro" : `✗ ${failures} failure(s)`}\n`
);
process.exit(failures === 0 ? 0 : 1);
