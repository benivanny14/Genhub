#!/usr/bin/env node
// =============================================================================
// GENHUB - Does R2 let THIS site upload the background clip?
// Run:  npm run verify:r2
//       npm run verify:r2 -- --origin https://www.genhub-two.site
//       npm run verify:r2 -- --origin https://www.genhub-two.site --origin http://localhost:3000
//
// -----------------------------------------------------------------------------
// The failure this script exists for
//
// The background clip is uploaded by the BROWSER, straight to R2, against a URL
// this server signs — a serverless function may neither receive nor return more
// than 4.5 MB, so no byte of it can pass through the app.
//
// That makes the bucket's CORS policy part of the deployment, and its absence is
// invisible from the server side in every way that matters:
//
//   the PUT is cross-origin and carries a content-type
//        -> the browser sends an OPTIONS preflight first
//   the policy does not name the origin it is browsing from
//        -> R2 answers 403 with no Access-Control-* headers
//        -> the browser never sends the file
//        -> XMLHttpRequest reports it with NO STATUS AT ALL, which is
//           indistinguishable from a dead connection
//
// So a correctly-signed PUT from curl or Node answers 200 while every real
// operator's browser is refused, and the only symptom inside the app is "the
// video could not be sent to storage. Check your connection" — which sends that
// operator to look at the one thing that is usually fine. That exact hour is what
// this script exists to save. PRODUCTION.md §2.5 is the long version.
//
// It is worse than one forgotten origin: the policy goes stale every time the
// site moves. A vercel.app host that becomes a custom domain, a second domain
// added later, a dev server on a port other than 3000 — none of those break
// anything visible, right up until someone tries to replace the backdrop.
//
// -----------------------------------------------------------------------------
// Read-only, and it needs no credentials
//
// An OPTIONS preflight is evaluated against the policy alone: it is not signed
// and it reads no object, so this script needs neither the S3 keys nor a clip
// that exists. It asks about a key shaped exactly like a real one and changes
// nothing.
//
// Exit codes: 0 = every origin asked about is allowed. 1 = at least one is
// refused. An unconfigured R2 is a skip (exit 0), so this is usable mid-setup.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const env = (key) => (process.env[key] || "").trim();

const accountId = env("R2_ACCOUNT_ID");
const bucket = env("R2_BUCKET") || env("R2_BUCKET_NAME");
const appUrl = env("NEXT_PUBLIC_APP_URL");
const publicBaseUrl = env("R2_PUBLIC_BASE_URL");

// -----------------------------------------------------------------------------
// Which origins to ask about
// -----------------------------------------------------------------------------

/** The origin of a URL, or "" when it is not one. */
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * `--origin` wins; otherwise the address the app believes it is served from.
 *
 * The app URL is the right default because it is the address an admin is given,
 * and a check that asked about some other host would pass while the operator's
 * own browser is refused.
 */
function requestedOrigins() {
  const flags = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--origin" && args[i + 1]) flags.push(originOf(args[i + 1]));
  }
  const explicit = flags.filter(Boolean);
  if (explicit.length) return { origins: [...new Set(explicit)], from: "--origin" };

  const appOrigin = originOf(appUrl);
  if (appOrigin) return { origins: [appOrigin], from: "NEXT_PUBLIC_APP_URL" };

  return { origins: ["http://localhost:3000"], from: "the development default" };
}

/**
 * The preflight a browser sends for this upload, asked of a key shaped exactly
 * like a real clip's: same bucket, same directory, same extension.
 */
async function preflight(origin) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${bucket}/site/background/${"0".repeat(24)}.mp4`;

  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      // What the browser is about to do, verbatim: a PUT carrying the signed
      // content type.
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(15_000),
  });

  return {
    status: response.status,
    allowedOrigin: response.headers.get("access-control-allow-origin") || "",
    allowedMethods: response.headers.get("access-control-allow-methods") || "",
  };
}

// -----------------------------------------------------------------------------
// The check
// -----------------------------------------------------------------------------

console.log("\n=== R2 background-video verification ===\n");

if (!accountId || !bucket) {
  warn(
    "R2_ACCOUNT_ID / R2_BUCKET are not set - skipping (the background clip has " +
      "no store to upload to, and the admin card says so with a 503)"
  );
  process.exit(0);
}

console.log(`  bucket: ${bucket}`);
console.log(`  host:   ${accountId}.r2.cloudflarestorage.com`);
if (publicBaseUrl) ok(`public hostname: ${publicBaseUrl} (playback is a redirect)`);
else
  warn(
    "R2_PUBLIC_BASE_URL is empty - playback is proxied through the app one range " +
      "at a time, which works but pays for the same bytes twice"
  );

const { origins, from } = requestedOrigins();
console.log(`  origins (from ${from}): ${origins.join(", ")}`);

let refused = 0;

for (const origin of origins) {
  try {
    const result = await preflight(origin);
    const allowed =
      result.allowedOrigin === origin || result.allowedOrigin === "*";

    if (allowed) {
      ok(`${origin} -> ${result.status}, preflight allowed`);
    } else {
      refused++;
      fail(
        `${origin} -> ${result.status}, and no Access-Control-Allow-Origin for it` +
          (result.allowedOrigin ? ` (the bucket answered for ${result.allowedOrigin})` : "")
      );
    }
  } catch (error) {
    refused++;
    fail(`${origin} -> the bucket could not be reached: ${error.message || error}`);
  }
}

if (refused > 0) {
  console.log(
    "\n  An origin that is not on the bucket's policy cannot upload the background\n" +
      "  clip: the browser refuses to send the file and reports it as a connection\n" +
      "  failure, because a refused preflight carries no status of its own.\n" +
      "\n  Fix it in Cloudflare: R2 -> " +
      bucket +
      " -> Settings -> CORS Policy, and make sure\n" +
      "  each origin above is an AllowedOrigin with PUT in AllowedMethods and\n" +
      "  content-type in AllowedHeaders. A change takes about a minute to appear.\n" +
      "\n  The same policy can be applied with the S3 API (PutBucketCors), which\n" +
      "  needs an R2 token with Admin Read & Write. See PRODUCTION.md 2.5.\n"
  );
  process.exit(1);
}

ok("every origin asked about can upload the background clip");
