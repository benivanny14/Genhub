// =============================================================================
// GENHUB - Endpoints that may only exist on somebody's machine
//
// Three routes can do things no public deployment may ever allow:
//
//   /api/auth/demo-login          mints a session — including an ADMIN one
//   /api/dev/sandbox/complete     marks an order paid without money moving
//   /api/demo/seed                writes invented creators, videos and payments
//
// Each was guarded by `process.env.NODE_ENV === "production"`, which is one
// variable away from being wrong on a self-hosted deployment: forget to set
// NODE_ENV and every one of them switches on, on a public URL. (`config.nodeEnv`
// is worse still — it DEFAULTS to "development" when unset, so it answers a
// question nobody asked.)
//
// The second signal is the one the cron guard already uses, for the same reason:
// no hosting provider hands out a localhost URL. A deployment that is reachable
// at `https://something` cannot be a laptop, whatever NODE_ENV says, so these
// routes refuse there even when the environment variable was never set.
//
// Both conditions must hold. A laptop (`http://localhost:3000`, the value in
// .env.example) keeps its demo accounts, its sandbox checkout and its seed
// script; anything with a real hostname does not, and a missing NODE_ENV is not
// a way around it.
// =============================================================================

import config from "./config";

/**
 * Is this deployment unmistakably running on a local machine?
 *
 * Deliberately about the URL rather than NODE_ENV: an unset NODE_ENV reads as
 * "development" and would answer yes for a server in a rack.
 */
export function isLocalAppUrl(url: string = config.appUrl): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url);
}

/**
 * May a development-only endpoint run here?
 *
 * True on a laptop, false everywhere else — including a preview deployment,
 * which is publicly reachable even though nobody calls it production.
 */
export function developmentOnlyEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && isLocalAppUrl();
}
