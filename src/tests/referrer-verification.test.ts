// =============================================================================
// GENHUB - Which hosts Bunny is asked about, and how its answer is read
//
// `npm run verify:referrers` signs one real manifest and asks the pull zone
// whether a given origin may play it. Two pieces of it decide whether the whole
// command is honest, and both are pure so they can be pinned here without a
// network:
//
//   * WHICH origins it asks about. The failure this command exists for is a
//     launch domain missing from the Allowed Referrers list, so a default list
//     that omits `www.<domain>` — or that pads itself with entries nobody can be
//     served from, such as `www.localhost` — is a check that reports the wrong
//     thing about the domain customers actually type.
//   * HOW an answer is classified. 403 is the referrer gate, but Bunny answers
//     403 to a wrong token as well, and the two need opposite fixes. The caller
//     distinguishes them with a bare baseline request; this only has to keep
//     2xx as "allowed" and everything else as refusal.
// =============================================================================

import { describe, it, expect } from "vitest";

import { resolveReferrerOrigins, classifyReferrerStatus } from "../../scripts/verify-referrers.mjs";

describe("resolveReferrerOrigins", () => {
  it("derives the app domain, its www form and localhost from the app URL", () => {
    const { origins, source } = resolveReferrerOrigins({
      appUrl: "https://genhub.co.tz",
    });

    expect(source).toBe("derived");
    expect(origins).toEqual([
      "https://genhub.co.tz",
      "https://www.genhub.co.tz",
      "http://localhost:3000",
    ]);
  });

  it("does not invent a www form that cannot ever be served", () => {
    // `www.localhost:3000` and `www.216.198.79.195` are entries nobody can be
    // served from — and a preview host is replaced on every deploy, so a list
    // padded with them is a list that stops being read.
    const local = resolveReferrerOrigins({ appUrl: "http://localhost:3000" });
    expect(local.origins).not.toContain("https://www.localhost:3000");

    const preview = resolveReferrerOrigins({ appUrl: "https://genhub-two.vercel.app" });
    expect(preview.origins).toEqual([
      "https://genhub-two.vercel.app",
      "http://localhost:3000",
    ]);

    const ip = resolveReferrerOrigins({ appUrl: "http://216.198.79.195" });
    expect(ip.origins).toEqual(["http://216.198.79.195", "http://localhost:3000"]);
  });

  it("accepts the forms people actually paste, and asks each question once", () => {
    // A trailing slash, a bare host, and the same host twice — the Referer Bunny
    // compares is `origin + "/"`, so all of these are one entry on the list.
    const { origins, source } = resolveReferrerOrigins({
      explicit: ["https://genhub.co.tz/", "genhub.co.tz", "https://genhub.co.tz"],
    });

    expect(source).toBe("explicit");
    expect(origins).toEqual(["https://genhub.co.tz"]);
  });

  it("prefers an explicit list, then BUNNY_ALLOWED_ORIGINS, then the app URL", () => {
    expect(
      resolveReferrerOrigins({
        explicit: ["https://a.example"],
        envList: "https://b.example",
        appUrl: "https://c.example",
      }).origins
    ).toEqual(["https://a.example"]);

    const fromEnv = resolveReferrerOrigins({
      envList: "https://genhub.co.tz, http://localhost:3000",
      appUrl: "https://c.example",
    });
    expect(fromEnv.source).toBe("BUNNY_ALLOWED_ORIGINS");
    expect(fromEnv.origins).toEqual(["https://genhub.co.tz", "http://localhost:3000"]);
  });

  it("keeps a non-default port, which is part of the Referer it must match", () => {
    const { origins } = resolveReferrerOrigins({
      explicit: ["http://localhost:3000/some/path?x=1"],
    });
    expect(origins).toEqual(["http://localhost:3000"]);
  });
});

describe("classifyReferrerStatus", () => {
  it("treats any 2xx as allowed, because a Range request answers 206", () => {
    expect(classifyReferrerStatus(206).allowed).toBe(true);
    expect(classifyReferrerStatus(200).allowed).toBe(true);
  });

  it("reads 403 and 401 as the referrer refusal Bunny does not explain", () => {
    expect(classifyReferrerStatus(403)).toEqual({ allowed: false, kind: "refused" });
    expect(classifyReferrerStatus(401)).toEqual({ allowed: false, kind: "refused" });
  });

  it("separates a missing manifest from a refused host", () => {
    // A video with only 240p/360p answers 404 for 1080p, and calling that a
    // referrer problem sends the reader to the wrong dashboard.
    expect(classifyReferrerStatus(404).kind).toBe("missing");
    expect(classifyReferrerStatus(400).kind).toBe("missing");
    expect(classifyReferrerStatus(500).kind).toBe("other");
  });
});
