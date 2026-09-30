// =============================================================================
// GENHUB - Public (client-safe) Configuration
// =============================================================================
// This module is the ONLY config a client component may import.
//
// Why it exists as a separate file: `lib/config.ts` holds the whole backend
// configuration — the database URL, the JWT secret, the Redis token, the Bunny
// keys, the payment credentials. Any client component that imported it dragged
// that ENTIRE object into the JavaScript a browser downloads, so variable names
// (and, in the worst case, values) ended up in the bundle. Splitting the public
// half out keeps the two worlds physically apart: nothing in this file reads a
// variable that is not already public.
//
// The rule for what may live here is exactly the one in the security brief:
// a value is admissible only if it is safe for every visitor to read.
// Application URL, application name and the public legal/support contact
// details qualify. Everything else stays in lib/config.ts, server-side.
//
// Never import lib/config.ts from a file that has "use client".
// =============================================================================

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * The public application URL.
 *
 * Resolved from NEXT_PUBLIC_APP_URL alone, because that is the field's whole
 * point: it is inlined at build time and identical on both sides of the wire.
 * `lib/config.ts` may refine this on the server with the hosting provider's own
 * URL variables, but a browser has no business reading those.
 */
function resolvePublicAppUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  return stripTrailingSlashes(explicit) || "http://localhost:3000";
}

/**
 * Values a client component may render.
 *
 * `compliance` is public by law: 28 C.F.R. 75.2 requires the custodian details
 * on /2257, and the support address is the contact a DMCA notice is sent to.
 */
const publicConfig = {
  appUrl: resolvePublicAppUrl(),
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Genhub",
  compliance: {
    legalName: process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME || "Genhub",
    address: process.env.NEXT_PUBLIC_COMPANY_ADDRESS || "",
    supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@genhub.co.tz",
    phone: process.env.NEXT_PUBLIC_SUPPORT_PHONE || "0682642219",
  },
} as const;

export default publicConfig;
