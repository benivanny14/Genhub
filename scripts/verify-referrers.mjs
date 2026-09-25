#!/usr/bin/env node
// =============================================================================
// GENHUB - Does Bunny actually let THIS domain play video?
// Run:  npm run verify:referrers
//       npm run verify:referrers -- --origin https://genhub.co.tz
//       npm run verify:referrers -- --origin https://genhub.co.tz --origin http://localhost:3000
//       npm run verify:referrers -- --video <bunny-guid>
//
// -----------------------------------------------------------------------------
// The failure this script exists for
//
// A pull zone can be gated TWO independent ways, and only one of them is visible
// from a server:
//
//   Token Authentication key wrong   -> every signed request 403s, server-side
//                                       probe included (probeSignedPlayback
//                                       catches this)
//   Allowed Referrers missing a host -> a correctly-signed manifest answers 206
//                                       with NO Referer and 200 for an allowed
//                                       host, but 403 for every host that is not
//                                       on the list (nothing in the app catches
//                                       this)
//
// The second gate reads the REFERER, and a server-to-server probe sends none, so
// the CDN reports perfectly healthy while every real viewer's browser — which
// always sends its own origin — is refused. The only symptom inside the app is a
// spinner. PRODUCTION.md §8.0.1 is the long version of this paragraph.
//
// It is worse than "one broken deploment": the app's own playback probe asks the
// CDN with the origin the DEPLOYMENT believes it is (config.appUrl). Deployed on
// genhub-two.vercel.app while the launch domain is genhub.co.tz, the probe asks
// about genhub-two.vercel.app, gets 200, and reports "playback OK" — while the
// domain customers actually type answers 403 for the manifest AND for every
// segment, because segments are fetched by the browser straight from the CDN and
// no server-side change can authorise one of those.
//
// So this asks the question per ORIGIN instead: it signs one real manifest and
// requests it once bare, then once with each candidate origin as Origin/Referer,
// and names the hosts that are missing from the list.
//
// -----------------------------------------------------------------------------
// Read-only, and it never needs the domain to exist
//
// GET on the Stream library, GET (Range, 2 KB) on the CDN. Nothing is written and
// no probe object is created, so this is safe to run against production at any
// time.
//
// The referrer list matches a STRING, not a resolution: Bunny compares the
// Referer header against its configured entries, and it never resolves DNS. So
// this reports the truth about genhub.co.tz BEFORE the domain has any nameserver
// record — which is exactly when it is worth knowing, because the list can be
// fixed ahead of the DNS switch instead of after customers see a spinner.
//
// Exit codes: 0 = every origin asked about is allowed. 1 = at least one is
// refused. An unconfigured Bunny is a skip (exit 0), so this is usable mid-setup.
// =============================================================================

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadEnv, ok, warn, fail } from "./_env.mjs";

// =============================================================================
// Which origins to ask about
// =============================================================================

/**
 * The origins to test: explicit `--origin` values when given, otherwise the
 * comma-separated `BUNNY_ALLOWED_ORIGINS`, otherwise derived from the app URL.
 *
 * Pure, so src/tests/referrer-verification.test.ts pins the defaults without
 * touching the network — including the two rules that are easy to get wrong:
 *
 *   - `www.` is derived from a bare domain, because a customer who types
 *     www.genhub.co.tz sends `https://www.genhub.co.tz/` as the Referer and a
 *     list that only names the apex refuses them. Measured against this zone,
 *     that is a 403, not a redirect: the browser never re-asks from the apex.
 *   - `http://localhost:3000` is derived too, because playback has to be
 *     testable on a laptop and localhost is otherwise always refused.
 *
 * A URL with a path or a trailing slash is trimmed to an origin, because the
 * Referer Bunny compares is `origin + "/"` — an entry pasted as
 * `https://genhub.co.tz/` and one pasted as `https://genhub.co.tz` are the same
 * question, and this asks it once.
 *
 * @param {object} [input]
 * @param {string[]} [input.explicit] values from repeated `--origin`
 * @param {string} [input.envList] the raw BUNNY_ALLOWED_ORIGINS value
 * @param {string} [input.appUrl] NEXT_PUBLIC_APP_URL, for the derived defaults
 * @returns {{ origins: string[], source: "explicit" | "BUNNY_ALLOWED_ORIGINS" | "derived" }}
 */
export function resolveReferrerOrigins({ explicit, envList, appUrl } = {}) {
  const clean = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // Keep the scheme; strip any path, query or trailing slash. A bare host is
    // accepted and assumed https, because that is how people paste it.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      return `${url.protocol}//${url.host}`;
    } catch {
      return "";
    }
  };

  const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];

  if (Array.isArray(explicit) && explicit.length > 0) {
    return { origins: unique(explicit), source: "explicit" };
  }

  if (String(envList || "").trim()) {
    return { origins: unique(String(envList).split(",")), source: "BUNNY_ALLOWED_ORIGINS" };
  }

  const app = clean(appUrl);
  const derived = [app, wwwSibling(app), "http://localhost:3000"];
  return { origins: unique(derived), source: "derived" };
}

/**
 * The `www.` form of an origin, or "" when there is nothing sensible to add.
 *
 * Only for a name that really is a domain: adding `www.` to localhost, to an IP
 * or to a Vercel preview host produces an entry nobody can ever be served from,
 * and a list padded with entries that cannot match is a list that stops being
 * read.
 */
function wwwSibling(origin) {
  if (!origin) return "";
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const isDomain =
      /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) &&
      !host.startsWith("www.") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host);
    if (!isDomain || host.endsWith(".vercel.app") || host.endsWith(".b-cdn.net")) return "";
    return `${url.protocol}//www.${url.host}`;
  } catch {
    return "";
  }
}

/**
 * What one answer means.
 *
 * `allowed` is deliberately any 2xx: a manifest answers 206 to a Range request
 * and 200 when the whole body is served, and both mean the pull zone accepted
 * the request. 403/401 is the referrer gate (or a wrong token, which the bare
 * baseline request has already ruled out by the time this is called).
 *
 * @returns {{ allowed: boolean, kind: "allowed" | "refused" | "missing" | "other" }}
 */
export function classifyReferrerStatus(status) {
  if (status >= 200 && status < 300) return { allowed: true, kind: "allowed" };
  // Bunny answers 403 for a host that is not on the list, and for both a bad
  // token and a disallowed host it does not say which — hence the baseline.
  if (status === 403 || status === 401) return { allowed: false, kind: "refused" };
  if (status === 404 || status === 400) return { allowed: false, kind: "missing" };
  return { allowed: false, kind: "other" };
}

// =============================================================================
// The probe itself
// =============================================================================

const env = (k) => (process.env[k] || "").trim().replace(/^"|"$/g, "");
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Bunny's token: base64url( SHA256(tokenSecret + path + expires) ).
 *
 * The same primitive and the same operand ORDER as src/lib/bunny.ts, and the
 * folder — not one file — is what gets signed, because one folder token
 * authorises the manifest and every rendition and segment under it. Getting any
 * of those three details wrong is a 403 that Bunny will not explain, which is why
 * this is a copy of that function rather than a "close enough" reimplementation.
 */
function signBunnyPath(secret, path, expiresAt) {
  return createHash("sha256")
    .update(`${secret}${path}${expiresAt}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** One bounded manifest request, dressed the way a browser sends it. */
async function requestStatus(url, origin) {
  try {
    const res = await fetch(url, {
      headers: {
        Range: "bytes=0-2047",
        // Both headers, because "Allowed Referrers" is implemented against the
        // Referer while some zones are configured from the Origin — sending one
        // and not the other would test a request no browser ever makes.
        ...(origin ? { Origin: origin, Referer: `${origin}/` } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return { status: res.status, error: null };
  } catch (error) {
    return { status: 0, error };
  }
}

/** A playable video to sign, so the probe needs no configuration beyond env. */
async function pickProbeVideo(key, library, requestedGuid) {
  if (requestedGuid) return requestedGuid;
  // status 4 is Bunny's "finished encoding" — anything lower has no manifest to
  // request yet, and a probe against one would report a referrer failure that is
  // really an unfinished encode.
  const res = await fetch(
    `https://video.bunnycdn.com/library/${library}/videos?page=1&itemsPerPage=50`,
    { headers: { AccessKey: key }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`library listing -> HTTP ${res.status}`);
  const body = await res.json();
  const video = (body.items || []).find((item) => Number(item.status) === 4);
  if (!video) throw new Error("no finished video in the library to sign");
  return video.guid;
}

function parseArgs(args) {
  const origins = [];
  let video = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--origin") origins.push(args[i + 1] || "");
    if (args[i] === "--video") video = (args[i + 1] || "").trim();
  }
  return { origins, video: video || env("BUNNY_PROBE_VIDEO") };
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(
      "\nusage: npm run verify:referrers [-- --origin <url>] [--video <guid>]\n" +
        "       --origin  a host to test (repeatable). Defaults to the app URL,\n" +
        "                 its www. form and http://localhost:3000, or to\n" +
        "                 BUNNY_ALLOWED_ORIGINS when that is set.\n" +
        "       --video   the Bunny GUID to sign; defaults to the newest finished video\n"
    );
    return;
  }

  const host = env("BUNNY_CDN_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const secret = env("BUNNY_TOKEN_SECRET");
  const key = env("BUNNY_STREAM_API_KEY");
  const library = env("BUNNY_STREAM_LIBRARY_ID");

  console.log("\n=== Bunny Allowed Referrers ===\n");

  if (!host || !secret) {
    warn("BUNNY_CDN_HOSTNAME / BUNNY_TOKEN_SECRET not set — nothing can be signed, so nothing to ask");
    console.log("");
    return;
  }

  const { origins, source } = resolveReferrerOrigins({
    explicit: parseArgs(args).origins,
    envList: env("BUNNY_ALLOWED_ORIGINS"),
    appUrl: env("NEXT_PUBLIC_APP_URL"),
  });

  if (origins.length === 0) {
    fail("no origins to test — pass --origin <url>");
    process.exitCode = 1;
    return;
  }

  console.log(`  CDN ${host}`);
  console.log(`  origins (${source}): ${origins.join("  ")}\n`);

  let guid;
  try {
    guid = await pickProbeVideo(key, library, parseArgs(args).video);
  } catch (error) {
    fail(`could not pick a video to sign: ${error.message || error}`);
    console.log("   (Bunny Stream key/library may be missing — see npm run smoke:bunny)\n");
    process.exitCode = 1;
    return;
  }

  const expires = Math.floor(Date.now() / 1000) + 600;
  const folder = `/${guid}/`;
  const token = signBunnyPath(secret, folder, expires);
  const manifestUrl = `https://${host}${folder}playlist.m3u8?token=${token}&expires=${expires}`;

  // ------------------------------------------------------------------- baseline
  // No Referer: proves the TOKEN works, so a 403 below can only mean the referrer
  // gate. Without this the two failures are indistinguishable — Bunny refuses
  // both with the same bare 403 and no explanation.
  const baseline = await requestStatus(manifestUrl);
  if (baseline.error) {
    fail(`the CDN did not answer: ${baseline.error.name || baseline.error.message || baseline.error}`);
    process.exitCode = 1;
    return;
  }
  if (baseline.status === 403 || baseline.status === 401) {
    fail(
      `the signed manifest was refused with no Referer (HTTP ${baseline.status}) — this is NOT the ` +
        "referrer list. BUNNY_TOKEN_SECRET is not this pull zone's own Token Authentication Key. " +
        "See PRODUCTION.md §8.0.1 and the Bunny probe in npm run verify:live."
    );
    process.exitCode = 1;
    return;
  }
  if (baseline.status < 200 || baseline.status >= 300) {
    fail(`the signed manifest answered HTTP ${baseline.status} — the video has no manifest to serve`);
    process.exitCode = 1;
    return;
  }
  ok(`signature accepted with no Referer (HTTP ${baseline.status}) — the token is valid`);

  // --------------------------------------------------------------- per origin
  const refusedOrigins = [];
  for (const origin of origins) {
    const { status } = await requestStatus(manifestUrl, origin);
    const verdict = classifyReferrerStatus(status);

    if (verdict.allowed) {
      ok(`${origin.padEnd(32)} allowed (HTTP ${status})`);
      continue;
    }

    refusedOrigins.push(origin);
    const why =
      verdict.kind === "refused"
        ? "NOT on the pull zone's Allowed Referrers list"
        : verdict.kind === "missing"
          ? `the CDN has no manifest at this path (HTTP ${status})`
          : `unexpected answer (HTTP ${status})`;
    fail(`${origin.padEnd(32)} ${why}`);
  }

  console.log("");
  if (refusedOrigins.length === 0) {
    console.log("Every origin asked about may play video.\n");
    return;
  }

  // ------------------------------------------------------------------- what now
  // The segments matter as much as the manifest: the browser fetches them
  // straight from the CDN, so a host missing from this list gets a 403 for the
  // manifest AND for every byte after it, and nothing in the app can proxy around
  // that.
  console.log(
    `${refusedOrigins.length} origin(s) refused. Add each one, as its own entry, to\n` +
      "  Bunny -> the Stream library's Pull Zone -> Security -> Allowed Referrers:\n\n" +
      refusedOrigins.map((origin) => `      ${origin}`).join("\n") +
      "\n\n" +
      "  There is no API for this in the Stream key this project holds (the Bunny\n" +
      "  account API answers 401 to it), so it is a dashboard change. The list is\n" +
      "  matched as a string and never resolved, so it can be set before the domain\n" +
      "  has DNS. Re-run this command to confirm it took effect.\n"
  );
  process.exitCode = 1;
}

// Only when run as a script: this module is imported by its own test, and the
// probe above must not fire there.
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  await main();
}
