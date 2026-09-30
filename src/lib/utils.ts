// =============================================================================
// GENHUB - Utility Functions
// =============================================================================

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Merge Tailwind classes safely
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// =============================================================================
// Client IP — for rate-limit keying on unauthenticated routes
//
// CALL THIS WITH `request.headers`, not the request: it accepts anything with a
// `get(name)` method, which keeps it dependency-free (usable from server code
// and middleware alike).
//
// Two things this gets right that the previous inline copies did not:
//
// 1. `x-forwarded-for` is a CHAIN ("client, proxy1, proxy2"). Each route used
//    to read it raw, so one client could present two different keys by
//    appending a value — a free rate-limit bypass. We take the last hop, which
//    is the entry appended by the proxy closest to us and therefore the one an
//    attacker cannot rewrite.
//
// 2. The old `|| "unknown"` fallback put EVERY header-less client into one
//    shared bucket. On a deployment that does not set the header, one abuser
//    could exhaust the limit for the entire site. We still need a fallback, but
//    it is now a single named value that is documented as shared rather than
//    an accident.
//
// Caveat worth knowing: if a deployment's proxy neither sets nor sanitises
// these headers, a client can pick its own key. That is why every AUTHENTICATED
// limit keys on the user id instead — see the routes that pass `auth.userId`.
// =============================================================================
export function clientIp(headers: { get(name: string): string | null }): string {
  // A single-value header is unambiguous when the platform sets it.
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  // Both of these are chains; take the last hop for both, for the same reason.
  for (const name of ["x-forwarded-for", "x-vercel-forwarded-for"]) {
    const hops = (headers.get(name) || "")
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return "unknown";
}

// Format TZS currency
export function formatTZS(amount: number): string {
  return new Intl.NumberFormat("en-TZ", {
    style: "currency",
    currency: "TZS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// Format large numbers (1.2K, 3.5M etc.)
export function formatCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

// Generate URL-safe slug
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 100);
}

// A whole number from a query string, or a default when it is missing or not a
// number.
//
// `parseInt("abc")` is NaN, and `Math.max(1, NaN)` is still NaN — so every
// listing route that wrote `Math.max(1, parseInt(page))` handed Prisma a NaN
// `skip`/`take` whenever anybody typed a letter into the page number. Prisma
// refuses that argument, so `/api/videos?page=abc` was a 500 instead of the
// feed, and the cache key was written for a page that cannot exist.
//
// The page and the limit are the same question ("a bounded positive integer,
// defaulting when absent"), asked by the feed, the directory and the admin
// queues, so it is answered in one place rather than by five copies of
// `parseInt` drifting apart.
export function intParam(
  raw: string | null | undefined,
  fallback: number,
  max: number = Number.MAX_SAFE_INTEGER
): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}

// Format relative time
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString("en-US");
}

// Format duration in seconds: mm:ss, or h:mm:ss once it passes an hour.
//
// A feature-length scene used to read "75:30", which is not a number anybody
// counts in — every other player writes "1:15:30", and this is the same figure on
// the card, in the player's clock and in the trailer's ribbon. A length that
// cannot be divided (a video whose metadata has not arrived) reads "0:00" rather
// than "NaN:NaN".
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (hours > 0) return `${hours}:${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// Validate Tanzanian phone number
export function isValidTZPhone(phone: string): boolean {
  // Matches: +255XXXXXXXXX or 0XXXXXXXXX
  return /^(\+255|0)[67]\d{8}$/.test(phone.replace(/\s/g, ""));
}

// A `tel:` link for a phone number as a person writes it.
//
// Tanzanian numbers are written locally as `0682 642 219` and internationally as
// `+255682642219`, and a `tel:` link needs the second form or the dialler treats
// "0682642219" as an incomplete local number. Same digits, one conversion, in a
// pure function so the two pages showing the number cannot disagree about it.
//
// Non-Tanzanian input is passed through with a leading `+` only when it already
// has a country code, so a number this app did not expect is still dialable
// rather than mangled.
export function toTelHref(phone: string): string {
  const digits = (phone || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+255")) return `tel:+${digits.slice(1)}`;
  if (digits.startsWith("255")) return `tel:+${digits}`;
  // Local form: 0XXXXXXXXX -> +255XXXXXXXXX (drop the trunk 0).
  if (digits.startsWith("0")) return `tel:+255${digits.slice(1)}`;
  if (digits.startsWith("+")) return `tel:${digits}`;
  return `tel:${digits}`;
}

// Truncate text
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// Generate random order ID
export function generateOrderId(prefix: string = "FBF"): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}
