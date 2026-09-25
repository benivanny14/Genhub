// =============================================================================
// GENHUB - Is this state-changing request coming from our own pages?
//
// `sameSite: "lax"` on the session cookie (lib/auth.ts) already stops a
// cross-site form from carrying somebody's session, which removes the classic
// CSRF against an authenticated action. It does not cover the requests that need
// no session at all:
//
//   * POST /api/auth/login  — "login CSRF". An attacker signs a victim into the
//     attacker's account, and the victim then does their own browsing inside a
//     profile somebody else controls. Nothing is stolen, which is exactly why it
//     goes unnoticed.
//   * POST /api/auth/register, /forgot-password, /reset-password — a form on any
//     other site can drive them, which is free account spam and free mail to our
//     users' inboxes.
//
// The fix is the one a browser already gives us: it attaches `Origin` to every
// cross-origin POST and cannot be forged by the page. So a request that carries
// an Origin naming a host we do not serve is refused.
//
// -----------------------------------------------------------------------------
// No Origin means yes
// -----------------------------------------------------------------------------
// A request without `Origin` is not a browser form — it is curl, a cron runner,
// a GitHub Action, or the payment gateway's callback. Those must keep working,
// and none of them can be triggered by a web page (a page cannot suppress the
// header). Refusing them would break the scheduler to stop an attack that the
// header's absence already rules out.
//
// Pure on purpose: no `Request`, no environment, so every branch is a unit test.
// =============================================================================

/** Hosts, lower-cased, without a port — so `EXAMPLE.com:443` and `example.com` match. */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, "");
}

export type OriginVerdict =
  | { ok: true; reason: "no-origin" | "same-origin" }
  | { ok: false; reason: "cross-origin" };

export function checkRequestOrigin(options: {
  /** The `Origin` header, if the caller sent one. */
  origin?: string | null;
  /** The `Host` header of the request being served. */
  host?: string | null;
  /**
   * Extra hostnames that count as us. The configured public app URL belongs
   * here: behind a proxy the `Host` we see and the origin the browser wrote can
   * legitimately differ, and a deployment with a custom domain should not start
   * refusing its own forms.
   */
  allowedHosts?: (string | null | undefined)[];
}): OriginVerdict {
  const { origin, host, allowedHosts = [] } = options;

  if (!origin) return { ok: true, reason: "no-origin" };

  let originHost: string;
  try {
    const url = new URL(origin);
    // `null` shows up for sandboxed frames and opaque origins; it is not a host
    // we serve, and treating it as "no origin" would be the loophole this check
    // exists to close.
    if (!url.host) return { ok: false, reason: "cross-origin" };
    originHost = normalizeHost(url.host);
  } catch {
    return { ok: false, reason: "cross-origin" };
  }

  const ours = [host, ...allowedHosts]
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      // An allowed host may be given as a bare host or as a full URL. The scheme
      // check is not optional: `new URL("genhub.co.tz:443")` parses "genhub.co.tz"
      // as a *scheme* (like mailto:), so its host is empty and a bare host with a
      // port would never match anything.
      if (value.includes("://")) {
        try {
          return normalizeHost(new URL(value).host);
        } catch {
          return normalizeHost(value);
        }
      }
      return normalizeHost(value);
    });

  return ours.includes(originHost)
    ? { ok: true, reason: "same-origin" }
    : { ok: false, reason: "cross-origin" };
}
