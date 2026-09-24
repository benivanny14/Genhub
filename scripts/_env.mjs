// =============================================================================
// GENHUB - Shared helper for scripts/: loads .env.local into process.env
// (no dependencies, works on every Node version) + tiny console helpers.
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Inline comments have to be stripped exactly the way the app's own loader
// (@next/env, via dotenv) strips them. `.env.example` documents every value with
// a trailing `# comment`, so anyone who copies that file and fills it in inline
// would otherwise get two different values: the app would see a clean URL while
// these scripts saw "https://genhub.co.tz   # live" and reported false failures.
// Quoted values keep their `#` verbatim, matching dotenv.
function stripInlineComment(value) {
  const quoted =
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1);
  if (quoted) return value.slice(1, -1);

  // Unquoted: an unescaped " #" (or a leading #) starts a comment.
  const hash = value.search(/(^|\s)#/);
  if (hash !== -1) value = value.slice(0, hash);
  return value.trim();
}

export function loadEnv(fileName = ".env.local") {
  const file = resolve(process.cwd(), fileName);
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = stripInlineComment(match[2].trim());
    // Real environment variables win over the file, so `FOO=bar npm run x` works.
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
  return true;
}

// -----------------------------------------------------------------------------
// `--env-from <path>` — run a gate against a different file
//
// The flag is NOT called `--env-file` on purpose: Node 20.6+ claims `--env-file`
// for itself, and it reads it even when it appears after the script path —
// `node scripts/verify-env.mjs --env-file x` makes NODE try to load `x` and exit
// with "x: not found" before a line of ours runs. A flag whose only failure mode
// is being eaten by the runtime is worse than an unfamiliar name.
//
// Every script here reads .env.local, which on a laptop means "what this checkout
// is configured with". The one question that cannot be answered that way is the
// one that matters after a deploy: what does the DEPLOYMENT hold? Vercel's
// variables are not visible from here, and the place people look for them — the
// hosting provider's dashboard — is a different list that has to be compared by
// eye.
//
// So the gates take a file instead of assuming one:
//
//   npx vercel env pull .env.vercel --environment=production
//   NODE_ENV=production npm run verify:env -- --env-from .env.vercel
//
// Same command, same exit code, same wording as the build that failed — but
// offline, before another push, and against the values the platform actually
// holds rather than the ones you believe you typed there.
//
// It is a snapshot, not the deployment: `vercel env pull` fetches values, and a
// value can be pulled and then deleted. That is why the gates say which file they
// read rather than calling it "production".
// -----------------------------------------------------------------------------

/**
 * The path after `--env-from`, or "" when the flag is absent or has no value.
 * Pure, so src/tests/env-loading.test.ts pins it without spawning anything.
 */
export function envFileFromArgs(args = process.argv.slice(2)) {
  const index = args.indexOf("--env-from");
  if (index === -1) return "";
  return (args[index + 1] || "").trim();
}

/**
 * Load EXACTLY ONE environment file: the `--env-from` path when given, otherwise
 * `.env.local`. Both real gates call this instead of `loadEnv` so the rule has a
 * single home.
 *
 * "Exactly one" is the whole point, and it is a bug this function exists to make
 * impossible. Loading a pulled file and then `.env.local` MERGES the two lists,
 * and a gate reports on the union — so a variable missing from the deployment is
 * quietly supplied by the developer's own file, and the check passes on data the
 * deployment will never see. Worse, it passes with a confident
 * "every critical setting is present", which is the opposite of the truth. That
 * exact mistake was in the first version of this flag.
 *
 * `.env.local` being absent is not an error (a CI runner has none), but an
 * explicitly named file that is absent IS: falling back silently would check the
 * wrong list and look like it worked.
 *
 * @returns {{ file: string, pulled: boolean, loaded: boolean } | { error: string, hint: string }}
 */
export function loadSingleEnv(args = process.argv.slice(2)) {
  const from = envFileFromArgs(args);
  const file = from || ".env.local";
  const loaded = loadEnv(file);
  if (from && !loaded) {
    return {
      error: `--env-from ${from} does not exist`,
      hint:
        "run this from the project root, or pull it first:  " +
        "npx vercel env pull .env.vercel --environment=production",
    };
  }
  return { file, pulled: Boolean(from), loaded };
}

// -----------------------------------------------------------------------------
// Secret strength — shared so preflight.mjs and verify-connections.mjs can never
// drift apart. Comparing against one literal string was not enough: the value in
// the real config was a DIFFERENT human-written placeholder
// ("dev-freebuff-…"), so it passed the exact-match test while remaining trivially
// guessable.
//
// Three independent ways a secret can be unfit to sign tokens:
//   length   — under 32 chars is brute-forceable
//   wording  — reads like a placeholder someone typed as a stopgap
//   entropy  — long but predictable prose ("correct horse battery staple…")
// -----------------------------------------------------------------------------
const PLACEHOLDER_PATTERN =
  /dev[-_]|test[-_]|change[-_]?me|placeholder|example|sample|default|your[-_]?(key|secret|token)|^secret$|secret$/i;

function entropyPerChar(value) {
  const freq = new Map();
  for (const ch of value) freq.set(ch, (freq.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * @returns {{ ok: boolean, reason?: string, entropy: number }}
 */
export function assessSecret(value) {
  if (!value) return { ok: false, reason: "empty", entropy: 0 };

  const entropy = entropyPerChar(value);
  if (PLACEHOLDER_PATTERN.test(value)) {
    return { ok: false, reason: "reads like a placeholder, not a generated secret", entropy };
  }
  if (value.length < 32) {
    return { ok: false, reason: `only ${value.length} characters (need 32+)`, entropy };
  }
  if (entropy < 3.0) {
    return {
      ok: false,
      reason: `predictable text (${entropy.toFixed(2)} bits/char, needs 3.0+)`,
      entropy,
    };
  }
  return { ok: true, entropy };
}

/**
 * True when BOTH Upstash REST variables are present.
 *
 * Upstash hands out two pairs of credentials (REST and TCP) and the app accepts
 * either — see src/lib/redis.ts. A check that only looked at REDIS_URL would
 * report "no managed Redis" to someone who configured the REST pair correctly,
 * which is exactly the kind of drift these scripts exist to prevent.
 */
export function hasRestRedis() {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || "").trim() &&
      (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim()
  );
}

export const ok = (msg) => console.log(`  \u2713 ${msg}`);
export const warn = (msg) => console.log(`  ! ${msg}`);
export const fail = (msg) => console.log(`  \u2717 ${msg}`);
