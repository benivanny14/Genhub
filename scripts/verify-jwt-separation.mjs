#!/usr/bin/env node
// =============================================================================
// GENHUB - Can this checkout's JWT_SECRET sign a session on the live site?
//
// Run:  npm run verify:jwt-separation
//       npm run verify:jwt-separation -- --url https://genhub-two.vercel.app
//       npm run verify:jwt-separation -- --url http://localhost:3000
//
// -----------------------------------------------------------------------------
// Why this exists
//
// `JWT_SECRET` is the whole authentication story: whoever holds it can mint a
// token for ANY account, including an ADMIN, and no server-side check can tell
// the difference between that token and a real login. It is exactly the kind of
// value that gets copied around — .env.local on a laptop, a hosting dashboard, a
// CI variable, a backup, a message to a contractor — and the failure is silent,
// because the value that is merely COPIED is still a valid key.
//
// The safe rule is one secret per environment: the value in a development
// checkout must not be accepted by production. Measured on this project, that was
// NOT the case — a token signed with .env.local's secret was accepted by the live
// deployment. That is not a bug in the code, it is a shared key, and the remedy
// is a rotation:
//
//   npx vercel env rm JWT_SECRET production
//   openssl rand -hex 32                             # paste into the dashboard
//   openssl rand -hex 32                             # a DIFFERENT value for dev
//   # put that second value in .env.local
//
// Rotating signs every user out once. That is the intended cost, and it is much
// smaller than the alternative.
//
// -----------------------------------------------------------------------------
// How it decides, without touching a real account
//
// It signs an HS256 token for a user id that does not exist, with role ADMIN, and
// asks the deployment a question whose answer depends ONLY on the signature:
// whether it treats the caller as an admin on a video that has a price
// (services/video-entitlement.service.ts grants `admin` before any database
// lookup). Nothing is created, nothing is written, and no real account is named.
//
//   refused  -> good: that deployment has its own secret. Exit 0.
//   accepted -> this checkout holds a key to it. Exit 1, with the steps above.
//
// It needs a paid, published video to ask about; with none it skips (exit 0), so
// it is usable against an empty deployment.
// =============================================================================

import { createHmac, randomUUID } from "node:crypto";
import { loadEnv } from "./_env.mjs";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return (args[index + 1] || "").trim() || fallback;
}

loadEnv(".env.local");

const BASE = flag("--url", process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "").replace(
  /\/+$/,
  ""
);
const SECRET = flag("--secret", process.env.JWT_SECRET || "");
const COOKIE = process.env.COOKIE_NAME || "genhub_token";

if (!BASE) {
  console.error(
    "\n  \u2717 no target — pass --url https://your-domain, " +
      "or set NEXT_PUBLIC_APP_URL in .env.local\n"
  );
  process.exit(2);
}

if (!SECRET) {
  console.error(
    "\n  \u2717 JWT_SECRET is not set in this checkout, so there is nothing to test. " +
      "This is the one case that CANNOT be checked from here.\n"
  );
  process.exit(2);
}

/** base64url of a JSON value, the way a JWT is assembled. */
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An HS256 token for a user who does not exist, signed with THIS checkout's
 * secret.
 *
 * HS256 is HMAC-SHA256 over `${header}.${payload}`, which is exactly what jose's
 * `SignJWT` produces in lib/auth.ts — the same issuer and audience too, because
 * verification checks them and a token that failed on either would be refused
 * for the wrong reason: this check would report "separate secrets" while the
 * secret is shared.
 */
function signedToken() {
  const now = Math.floor(Date.now() / 1000);
  const body = [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({
      userId: `jwt-separation-check-${randomUUID()}`,
      role: "ADMIN",
      iss: "genhub",
      aud: "genhub-app",
      iat: now,
      exp: now + 120,
    }),
  ].join(".");

  const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function main() {
  console.log(`\nJWT secret separation — ${BASE}`);
  console.log("Can the secret in THIS checkout sign a session on that deployment?\n");

  // A paid, published video: the entitlement answer for an ADMIN depends only on
  // the token, which is what makes this a signature test rather than a login test.
  const list = await fetch(`${BASE}/api/videos?limit=25`)
    .then((r) => r.json())
    .catch(() => null);
  const paid = (list?.data?.videos || []).find((v) => v.price > 0);

  if (!paid) {
    console.log("  \u2022 no paid video to ask about — skipping (nothing to prove here)\n");
    process.exit(0);
  }

  const res = await fetch(`${BASE}/api/videos/${paid.id}`, {
    headers: { Cookie: `${COOKIE}=${signedToken()}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  const accepted = res.status === 200 && body?.data?.hasAccess === true;

  if (accepted) {
    console.log(`  \u2717 ACCEPTED — ${BASE} treats a token signed with this checkout's`);
    console.log("    JWT_SECRET as an ADMIN session on a paid video.");
    console.log("\n    A copy of that secret is a key to every account, including an admin's.");
    console.log("    Rotate it, and keep a different value per environment:\n");
    console.log("      npx vercel env rm JWT_SECRET production");
    console.log("      openssl rand -hex 32        # paste into the hosting dashboard");
    console.log("      openssl rand -hex 32        # a DIFFERENT value for .env.local\n");
    console.log("    Everyone is signed out once. That is the point.\n");
    process.exit(1);
  }

  console.log(
    `  \u2713 refused (HTTP ${res.status}) — that deployment has its own secret, so this`
  );
  console.log("    checkout cannot sign in as anybody there.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n  \u2717 ${error?.message || error}\n`);
  process.exit(2);
});
