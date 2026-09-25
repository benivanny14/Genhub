// =============================================================================
// GENHUB - Where did this write come from?
//
// The session cookie is `sameSite: "lax"`, which already stops another site from
// making a request that carries somebody's session. What lax does not cover is
// the requests that need no session: login, register, forgot-password and
// reset-password can each be driven by a form on any other page, which is login
// CSRF and free account spam.
//
// `Origin` is the browser's own answer and cannot be forged by the page, so a
// write that names a host we do not serve is refused. The interesting case is the
// ABSENT header: that is curl, a cron runner, or the payment gateway's callback,
// none of which a web page can produce, so refusing it would break the scheduler
// to stop an attack the missing header already rules out.
//
// Pure function, no request needed.
// =============================================================================

import { describe, it, expect } from "vitest";

import { checkRequestOrigin } from "@/lib/request-origin";

describe("requests that carry no Origin", () => {
  it("are allowed, because a web page cannot produce one", () => {
    // curl, the cron runner, the GitHub Action, HarakaPay's webhook.
    expect(checkRequestOrigin({ host: "genhub.co.tz" })).toEqual({
      ok: true,
      reason: "no-origin",
    });
  });

  it("are allowed even with an empty string, not just null", () => {
    expect(checkRequestOrigin({ origin: "", host: "genhub.co.tz" })).toEqual({
      ok: true,
      reason: "no-origin",
    });
  });
});

describe("SameSite=lax already covers the rest, but: requests from our own pages", () => {
  it("match on the request's own host", () => {
    expect(
      checkRequestOrigin({
        origin: "https://genhub.co.tz",
        host: "genhub.co.tz",
      })
    ).toEqual({ ok: true, reason: "same-origin" });
  });

  it("ignore a port and letter case", () => {
    expect(
      checkRequestOrigin({
        origin: "https://GenHub.co.tz:443",
        host: "genhub.co.tz:443",
      }).ok
    ).toBe(true);
  });

  it("match the configured app URL, because a proxy may rewrite Host", () => {
    expect(
      checkRequestOrigin({
        origin: "https://genhub.co.tz",
        host: "internal-abc123.vercel.app",
        allowedHosts: ["https://genhub.co.tz/"],
      })
    ).toEqual({ ok: true, reason: "same-origin" });
  });

  it("accept an allowed host given as a bare hostname", () => {
    expect(
      checkRequestOrigin({
        origin: "https://genhub.co.tz",
        host: "something-else",
        allowedHosts: ["genhub.co.tz"],
      }).ok
    ).toBe(true);
  });
});

describe("somebody else's page", () => {
  it("is refused when the Origin is a different host", () => {
    expect(
      checkRequestOrigin({
        origin: "https://evil.example",
        host: "genhub.co.tz",
      })
    ).toEqual({ ok: false, reason: "cross-origin" });
  });

  it("is refused even when the hostname merely starts the same", () => {
    // The classic bypass: genhub.co.tz.evil.example is not genhub.co.tz.
    expect(
      checkRequestOrigin({
        origin: "https://genhub.co.tz.evil.example",
        host: "genhub.co.tz",
      }).ok
    ).toBe(false);
  });

  it("is refused when the Origin is not a URL at all", () => {
    expect(checkRequestOrigin({ origin: "not a url", host: "genhub.co.tz" }).ok).toBe(
      false
    );
  });

  it("is refused for the opaque origin a sandboxed frame reports", () => {
    // `null` is not "no header", and treating it as one would reopen the hole.
    expect(checkRequestOrigin({ origin: "null", host: "genhub.co.tz" }).ok).toBe(false);
  });
});
