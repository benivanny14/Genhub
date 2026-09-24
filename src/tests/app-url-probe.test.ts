// =============================================================================
// GENHUB - The "Public URL" probe
//
// The bug this suite exists for: the probe fetched `<appUrl>/api/health` and
// called any non-2xx answer a failed public URL. /api/health answers 503
// whenever the deployment is degraded — and degraded includes the background
// workers running late. So a perfectly reachable deployment reported its own job
// lag back to itself as "Public URL -> HTTP 503", which then travelled into
// `launch:check --remote` ("2 service(s) failing — HarakaPay, Public URL") and
// into the post-deploy workflow, sending whoever read it to DNS and to
// NEXT_PUBLIC_APP_URL — neither of which was wrong.
//
// The rule: an answer from OUR health payload is a pass on reachability, with
// the status echoed; a warn while degraded (visible on the admin card, kept out
// of `failing`); and a plain failure when the address answers with something
// else entirely, because NEXT_PUBLIC_APP_URL feeds the sitemap, OG tags and the
// gateway's webhook_url.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { classifyAppUrlAnswer } from "@/lib/setup-check";

const URL_ = "https://genhub.example.test";

/** The real body /api/health answers with while degraded. */
const degradedBody = {
  status: "degraded",
  uptimeSec: 157,
  nodeEnv: "production",
  checks: { database: "up", backgroundJobs: "late" },
  warnings: ["AT_API_KEY is not set"],
  timestamp: "2026-09-24T21:04:28.538Z",
};

const healthyBody = { ...degradedBody, status: "ok", checks: { database: "up", backgroundJobs: "ok" } };

describe("classifyAppUrlAnswer", () => {
  it("passes a deployment that answers 503 because it is degraded", () => {
    const verdict = classifyAppUrlAnswer(503, degradedBody, URL_);

    // The important half: not "fail". `failing` is what the watchdog alarm and
    // `launch:check --remote` read as a broken service, so a degraded-but-
    // reachable deployment must never land there.
    expect(verdict.state).toBe("warn");
    expect(verdict.detail).toContain("HTTP 503");
    // And it still says what it saw, so the card is not quietly green either.
    expect(verdict.detail).toContain("degraded");
  });

  it("passes a healthy deployment", () => {
    const verdict = classifyAppUrlAnswer(200, healthyBody, URL_);
    expect(verdict.state).toBe("ok");
    expect(verdict.detail).toContain("HTTP 200");
    expect(verdict.detail).not.toContain("degraded");
  });

  it("fails when the address answers with something that is not this app", () => {
    // The dangerous shape: a 200 from a different site means NEXT_PUBLIC_APP_URL
    // is pointing somewhere this deployment does not control.
    const verdict = classifyAppUrlAnswer(200, "<html>Welcome to WordPress</html>", URL_);
    expect(verdict.state).toBe("fail");
    expect(verdict.detail).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("fails when there is no readable answer at all", () => {
    expect(classifyAppUrlAnswer(502, null, URL_).state).toBe("fail");
  });

  it("does not read a status code as the verdict", () => {
    // The exact regression: a 5xx from our own app used to decide the outcome on
    // its own, whatever the deployment was actually saying.
    expect(classifyAppUrlAnswer(500, healthyBody, URL_).state).toBe("ok");
  });
});

// -----------------------------------------------------------------------------
// The wiring, which is where the bug lived.
// -----------------------------------------------------------------------------
describe("the Public URL probe reaches that rule", () => {
  const source = readFileSync(join(process.cwd(), "src", "lib", "setup-check.ts"), "utf8");
  const probe = source.slice(source.indexOf("async function probeAppUrl"));

  it("decides with the classifier rather than on res.ok", () => {
    expect(probe).toContain("classifyAppUrlAnswer(");
    expect(probe).not.toContain("res.ok");
  });

  it("reads the body, so the deployment's own status is available", () => {
    expect(probe).toContain("res.json()");
  });
});

describe("warn is not a failure to the alarm", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "app", "api", "health", "services", "route.ts"),
    "utf8"
  );

  it("counts only state === 'fail' as failing", () => {
    // Read from the source because that is where the coupling lives: if `warn`
    // ever joined this list, the probe fix above would silently stop working and
    // the watchdog would alarm on a URL that is fine.
    expect(source).toMatch(/const\s+failing\s*=\s*probes\.filter\(\(p\)\s*=>\s*p\.state\s*===\s*["']fail["']\)/);
  });
});
