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

export function loadEnv() {
  const file = resolve(process.cwd(), ".env.local");
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
