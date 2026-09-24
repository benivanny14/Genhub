// =============================================================================
// GENHUB - Where a ?redirect= may send you
//
// The middleware sends you to `/login?redirect=/admin` when you ask for a page
// that needs a session, and the login form used to ignore it: signing in landed
// on the home page, so the page you were actually going to had to be found
// again by hand. Reading the value is the easy half — the careless version of
// this is an open redirect, which turns our login page into a launchpad
// (`?redirect=https://evil.example`) and is the reason this lives in its own
// module with its own tests instead of inline in the form.
//
// The rule: the value must be a path on this site. An absolute URL, a
// protocol-relative `//host` (which a browser happily reads as another origin),
// a scheme like `javascript:`, or anything empty is refused — and refusing
// means the home page, never an error.
// =============================================================================

/** A path on this site, or null when the value is not one. */
export function safeInAppPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value.startsWith("/")) return null;
  // `//evil.example` and `/\evil.example` are other origins to a browser.
  if (/^\/[/\\]/.test(value)) return null;
  // A scheme or a host smuggled after the slash: `/\/` and `/http://x` are not
  // paths, and neither is a control character.
  if (/[\x00-\x1f\x7f]/.test(value)) return null;

  return value;
}
