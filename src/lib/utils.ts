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

// Format duration in seconds to mm:ss
export function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// Validate Tanzanian phone number
export function isValidTZPhone(phone: string): boolean {
  // Matches: +255XXXXXXXXX or 0XXXXXXXXX
  return /^(\+255|0)[67]\d{8}$/.test(phone.replace(/\s/g, ""));
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
