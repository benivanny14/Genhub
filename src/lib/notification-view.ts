// =============================================================================
// GENHUB - How a notification is READ
//
// A notification row is plain data (title, message, type, link, isRead,
// createdAt) and two surfaces draw it: the bell in the header and the
// /notifications page. The things that decide how it LOOKS — which colour the
// type maps to, how old it reads as, and whether its link is somewhere we are
// willing to navigate to — live here so the dropdown and the page cannot drift
// into describing the same row two different ways.
//
// Pure functions, no React and no Prisma: they are the part worth pinning with
// tests, because a wrong tone is a warning that reads as an error and a wrong
// age is "2m ago" on yesterday's message.
// =============================================================================

/** The four tones a notification can carry, matching the API's `type`. */
export type NotificationTone = "success" | "warning" | "error" | "info";

const TONES: NotificationTone[] = ["success", "warning", "error", "info"];

/**
 * The tone for a notification's `type`.
 *
 * Anything unrecognised — a type added by a newer server, an empty string, a
 * null — reads as `info`. Defaulting to the neutral tone is deliberate: a row
 * with no known meaning must not borrow the alarm of one.
 */
export function notificationTone(type: string | null | undefined): NotificationTone {
  const value = (type || "").trim().toLowerCase();
  return (TONES as string[]).includes(value) ? (value as NotificationTone) : "info";
}

/**
 * Where a notification's link may take the reader, or null.
 *
 * Only an in-app path is honoured: it must start with a single `/`, which
 * accepts `/creator`, `/admin` and `/video/abc` and refuses `https://…`,
 * `javascript:…` and a protocol-relative `//evil.example` — the shapes that turn
 * "open the notification the admin sent" into a navigation somewhere else.
 */
export function notificationHref(link: string | null | undefined): string | null {
  const value = (link || "").trim();
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  return value;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a notification arrived, in the shortest honest form.
 *
 * `now` is a parameter so the buckets are testable without freezing the clock,
 * and so two rows drawn in one render agree on what "now" means.
 *
 * Failing toward the raw date, not toward "just now": an unparseable timestamp
 * is a data problem, and calling it "just now" hides it behind a fresh-looking
 * badge. The date is str, and str is not a lie.
 */
export function formatNotificationAge(
  date: string | Date | null | undefined,
  now: number = Date.now()
): string {
  const at = date instanceof Date ? date.getTime() : Date.parse(String(date ?? ""));
  if (!Number.isFinite(at)) return "";

  const seconds = Math.floor((now - at) / 1000);
  // A clock a little ahead of ours reads as "just now" rather than a negative
  // age, which is what a creator's phone set to the wrong minute would produce.
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  const days = Math.floor(seconds / DAY);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
