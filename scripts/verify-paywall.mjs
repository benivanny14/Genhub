#!/usr/bin/env node
// =============================================================================
// GENHUB - Can a visitor who has not paid watch the video?
//
// Run:  npm run verify:paywall
//       npm run verify:paywall -- --url https://genhub-two.vercel.app
//       npm run verify:paywall -- --url http://localhost:3000 --limit 5
//
// -----------------------------------------------------------------------------
// Why this exists
//
// "The paywall is broken, everyone can watch for free" is the kind of report that
// has to be settled with evidence, not with an argument about the code. It has
// three common causes, and only one of them is a leak:
//
//   1. Someone tested while signed in as the video's CREATOR or as an ADMIN.
//      Both are entitled on purpose (services/video-entitlement.service.ts), so
//      every page plays — and the paywall is working. Nobody looking at the
//      screen can tell the difference, which is why the watch page now NAMES the
//      reason ("Your video — you can always watch it").
//   2. The video's price was set to 0. A free video is open to everyone by
//      design, and this script says so loudly instead of calling it a leak.
//   3. A real leak.
//
// This asks the only question that distinguishes them: with NO COOKIE AT ALL,
// does the deployment hand out anything playable for a video that has a price?
//
// -----------------------------------------------------------------------------
// What it checks, per published video
//
//   GET /api/videos/<id>              hasAccess must be false, and must carry no
//                                     playbackUrl. Also that the response does not
//                                     carry the raw media fields (previewUrl,
//                                     bunnyVideoId, teaserBunnyVideoId,
//                                     teaserClipUrl) — previewUrl IS the full
//                                     scene for side-loaded rows, so leaking it
//                                     leaks the video.
//   GET /api/videos/<id>/stream       must refuse (401/403/404). A 200 is the
//                                     full HLS manifest, anonymously.
//   GET /api/videos/<id>/download     must refuse. A 200 is the MP4 file.
//
// It also asserts that a teaser URL for a paid video is never that video's own
// stream endpoint: the teaser door serves without an entitlement check on
// purpose, so a teaser pointed at the scene is the one configuration that hands
// the whole video to everybody (see resolveTeaserUrl).
//
// -----------------------------------------------------------------------------
// Read-only, safe against production
//
// GETs only, no cookies, no writes. It never creates a purchase, a session or a
// probe object. Run it against the live domain whenever this claim comes up.
//
// Exit codes: 0 = the paywall holds (or there are no paid videos to check).
//             1 = at least one leak was found.
// =============================================================================

const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return (args[index + 1] || "").trim() || fallback;
}

const BASE = flag("--url", process.env.APP_URL || "https://genhub-two.vercel.app").replace(
  /\/+$/,
  ""
);
const LIMIT = Math.max(1, Number(flag("--limit", "25")) || 25);

let failures = 0;
let checks = 0;

const ok = (label) => {
  checks++;
  console.log(`  \u2713 ${label}`);
};
const bad = (label, detail) => {
  checks++;
  failures++;
  console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
};
const skip = (label) => console.log(`  \u2022 ${label}`);

/**
 * A request with no cookie, no cache and no redirect following.
 *
 * `redirect: "manual"` matters: a 3xx followed automatically could land on a
 * playable manifest and be reported as a clean 200 — or hide a refusal behind a
 * login redirect and be reported as a leak. We want the status the route itself
 * answered with.
 */
async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    cache: "no-store",
    headers: { Accept: "application/json, */*" },
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A manifest body is not JSON; that is the point of checking the status.
  }
  return { status: res.status, json, text };
}

/** Field names that must never appear in a public response. */
const RAW_MEDIA_FIELDS = [
  "previewUrl",
  "bunnyVideoId",
  "teaserBunnyVideoId",
  "teaserClipUrl",
];

async function main() {
  console.log(`\nPaywall check — ${BASE}`);
  console.log("Signed out, no cookies: a paid video must not be playable.\n");

  // ------------------------------------------------------------------ The feed
  let feed;
  try {
    feed = await get(`/api/videos?limit=${LIMIT}`);
  } catch (error) {
    console.error(`  \u2717 cannot reach ${BASE} — ${error.message}\n`);
    process.exit(1);
  }

  if (feed.status !== 200 || !feed.json?.success) {
    console.error(
      `  \u2717 /api/videos answered HTTP ${feed.status} — cannot list the catalogue\n`
    );
    process.exit(1);
  }

  const videos = feed.json.data?.videos ?? [];
  console.log(`${videos.length} published video(s) in the feed.`);

  for (const field of RAW_MEDIA_FIELDS) {
    if (JSON.stringify(videos).includes(`"${field}"`)) {
      bad(`/api/videos does not leak \`${field}\``, "the field is in the public feed payload");
    } else {
      ok(`/api/videos does not leak \`${field}\``);
    }
  }

  // Same question for the front page, which builds its own payload.
  const homeFeed = await get("/api/home-feed");
  if (homeFeed.status === 200) {
    for (const field of RAW_MEDIA_FIELDS) {
      if (JSON.stringify(homeFeed.json).includes(`"${field}"`)) {
        bad(`/api/home-feed does not leak \`${field}\``);
      }
    }
  }

  let paid = 0;
  let free = 0;

  for (const video of videos) {
    const name = `${video.title} (${video.slug || video.id})`;
    console.log(`\n${name} — ${video.price > 0 ? `TZS ${video.price}` : "free"}`);

    const detail = await get(`/api/videos/${video.id}`);

    if (detail.status !== 200) {
      // An unpublished or removed video answering 404 here is not a leak.
      skip(`not readable anonymously (HTTP ${detail.status}) — nothing to leak`);
      continue;
    }

    const data = detail.json?.data ?? {};

    if (data.price === 0) {
      free++;
      if (data.hasAccess === true && data.playbackUrl) {
        skip("free video, open to everyone (expected)");
      } else {
        bad(
          "a free video is watchable by anyone",
          "hasAccess is false or there is no playbackUrl — free scenes should play"
        );
      }
      continue;
    }

    paid++;

    if (data.hasAccess === false) {
      ok("hasAccess is false for a visitor who has not paid");
    } else {
      bad(
        `hasAccess is ${JSON.stringify(data.hasAccess)} for a signed-out visitor`,
        "a video with a price is being granted access with no session"
      );
    }

    if (!data.playbackUrl) {
      ok("no playbackUrl is handed out");
    } else {
      bad("no playbackUrl is handed out", `the response contains ${JSON.stringify(data.playbackUrl)}`);
    }

    // The teaser door skips entitlement, so a teaser that is the scene is the
    // leak this check exists for.
    if (data.teaserUrl && !String(data.teaserUrl).includes("source=teaser")) {
      bad(
        "a paid video's teaser is not its own stream",
        `teaserUrl is ${JSON.stringify(data.teaserUrl)} — it must be a separate clip`
      );
    } else if (data.teaserUrl) {
      const teaser = await get(String(data.teaserUrl).replace(BASE, ""));
      if (teaser.status === 200) {
        skip(`teaser clip is public (HTTP 200) — expected, trailers are for non-buyers`);
      } else {
        skip(`teaser clip answers HTTP ${teaser.status}`);
      }
    } else {
      skip("no teaser for this scene — nothing is previewed, which is the safe default");
    }

    const stream = await get(`/api/videos/${video.id}/stream`);
    if (stream.status === 200) {
      bad(
        "GET /api/videos/<id>/stream refuses an anonymous request",
        "HTTP 200 — the stream manifest is public"
      );
    } else {
      ok(`GET /api/videos/<id>/stream refuses an anonymous request (HTTP ${stream.status})`);
    }

    const download = await get(`/api/videos/${video.id}/download`);
    if (download.status === 200) {
      bad(
        "GET /api/videos/<id>/download refuses an anonymous request",
        "HTTP 200 — a file URL was handed out"
      );
    } else {
      ok(`GET /api/videos/<id>/download refuses an anonymous request (HTTP ${download.status})`);
    }
  }

  console.log(`\n${checks} check(s) · ${paid} paid video(s) · ${free} free video(s)`);

  if (failures > 0) {
    console.log(
      `\n  \u2717 ${failures} leak(s) found — a visitor with no session can reach paid video.\n`
    );
    process.exit(1);
  }

  console.log(
    "\n  \u2713 The paywall holds: nothing with a price plays without a session.\n" +
      "    If a video still plays in your browser, you are signed in as its creator\n" +
      "    or as an admin — the watch page names that reason under the player.\n"
  );
}

main().catch((error) => {
  console.error(`\n  \u2717 ${error?.stack || error}\n`);
  process.exit(1);
});
