// =============================================================================
// GENHUB - The one-line verdict after a deploy
//
// `npm run launch:check` exists so the post-deploy sequence stops being four
// commands run from memory — the one that gets skipped is always the last, and
// the last one is a real USSD push.
//
// Two things are pinned here, and they fail in opposite directions:
//
//   * the parsers, because a summary that reads "0 blocker(s)" off an output it
//     never understood is worse than no summary at all; and
//   * the guard on the collect step, because a post-deploy check that quietly
//     charged a customer would be a worse bug than the one it hunts for.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeDuration,
  parseWait,
  renderMarkdown,
  summarizePreflight,
  summarizeRemoteHealth,
  summarizeRemoteServices,
  summarizeVerify,
} from "../../scripts/launch-check.mjs";

describe("summarizePreflight", () => {
  it("reads the totals out of the verdict line", () => {
    expect(summarizePreflight("…\n=== 0 blocker(s), 0 warning(s) ===\nLaunch-ready.")).toEqual({
      ok: true,
      detail: "0 blocker(s), 0 warning(s)",
    });

    expect(summarizePreflight("=== 4 blocker(s), 1 warning(s) ===")).toEqual({
      ok: false,
      detail: "4 blocker(s), 1 warning(s)",
    });
  });

  it("fails when there is no verdict to read", () => {
    // A crash, or a run killed halfway. Reporting that as "0 blockers" is the
    // one answer that makes this command worse than useless.
    expect(summarizePreflight("ReferenceError: spawnSync is not defined")).toEqual({
      ok: false,
      detail: "did not finish — no verdict in the output",
    });
    expect(summarizePreflight("").ok).toBe(false);
  });
});

describe("summarizeVerify", () => {
  it("passes when every configured value works", () => {
    expect(summarizeVerify("…\nEverything configured is working.\n")).toEqual({
      ok: true,
      detail: "every connection works",
    });
  });

  it("still passes with warnings, but says how many", () => {
    const verdict = summarizeVerify("Everything configured is working. 2 warning(s) — see ! above.");
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("2 warning(s)");
  });

  it("counts what is broken", () => {
    const verdict = summarizeVerify(
      "2 configured value(s) are broken. 1 warning(s) — see ! above."
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toBe("2 configured value(s) broken · 1 warning(s)");
  });

  it("fails when there is no verdict to read", () => {
    expect(summarizeVerify("boom").ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// --remote: the check CI runs, because it needs two values instead of twenty
// -----------------------------------------------------------------------------

describe("summarizeRemoteHealth", () => {
  const body = (status: string) => ({
    status,
    checks: { database: status === "ok" ? "up" : "down", backgroundJobs: "on-time" },
  });

  it("passes only on an explicit ok", () => {
    expect(summarizeRemoteHealth(body("ok"), 200).ok).toBe(true);
  });

  it("treats degraded as a failure and says what stopped", () => {
    const verdict = summarizeRemoteHealth(body("degraded"), 503);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("database down");
  });

  it("fails on anything that is not that document", () => {
    // An HTML error page from a proxy, a 404, a truncated body: none of these
    // may read as "healthy", which is the whole reason the shape is checked
    // rather than the HTTP status alone.
    expect(summarizeRemoteHealth({}, 200).ok).toBe(false);
    expect(summarizeRemoteHealth(null, 502).detail).toContain("HTTP 502");
  });
});

describe("summarizeRemoteServices", () => {
  it("passes when nothing is failing, and names what is not configured", () => {
    const verdict = summarizeRemoteServices(
      { success: true, data: { verdict: "ok", failing: [], skipped: ["smtp"] } },
      200
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("1 not configured (smtp)");
  });

  it("names the services that are configured but broken", () => {
    const verdict = summarizeRemoteServices(
      {
        success: true,
        data: {
          verdict: "degraded",
          failing: [
            { id: "harakapay", name: "HarakaPay", detail: "float 0" },
            { id: "bunny", name: "Bunny Stream", detail: "401" },
          ],
          skipped: [],
        },
      },
      200
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toBe("2 service(s) failing — HarakaPay, Bunny Stream");
  });

  it("says the secret is wrong rather than blaming the services", () => {
    // A 401 here means the check could not ask, not that the gateway is down.
    // Sending someone to look at HarakaPay because CRON_SECRET drifted is the
    // expensive kind of wrong.
    expect(summarizeRemoteServices(null, 401).detail).toContain("CRON_SECRET");
  });
});

describe("parseWait", () => {
  it("does not wait unless it was asked to", () => {
    // The default run must stay a single question with a single answer.
    expect(parseWait(["--remote"]).enabled).toBe(false);
  });

  it("takes a five minute budget from a bare --wait", () => {
    const wait = parseWait(["--remote", "--wait"]);
    expect(wait.enabled).toBe(true);
    expect(wait.budgetMs).toBe(300_000);
  });

  it("accepts a spelled-out budget", () => {
    expect(parseWait(["--wait=600"]).budgetMs).toBe(600_000);
  });

  it("falls back to the default rather than to forever", () => {
    // A typo must never become an unbounded wait: a CI job that hangs until the
    // runner kills it reports nothing at all about the deployment.
    expect(parseWait(["--wait=soon"]).budgetMs).toBe(300_000);
    expect(parseWait(["--wait=0"]).budgetMs).toBe(300_000);
    expect(parseWait(["--wait=-5"]).budgetMs).toBe(300_000);
  });
});

describe("describeDuration", () => {
  it("reads in minutes once past a minute", () => {
    expect(describeDuration(45_000)).toBe("45s");
    expect(describeDuration(90_000)).toBe("1m30s");
    expect(describeDuration(300_000)).toBe("5m");
  });
});

describe("renderMarkdown", () => {
  const report = {
    ready: false,
    url: "https://genhub.co.tz",
    steps: [
      { name: "deployed /api/health", ok: true, detail: "database up · background jobs on-time" },
      { name: "deployed live credentials", ok: false, detail: "1 service(s) failing — HarakaPay" },
      { name: "HarakaPay collect", ok: true, skipped: true, detail: "SKIPPED" },
    ],
  };

  it("puts the verdict and every step into the run's summary", () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("## Launch check — NOT READY");
    expect(markdown).toContain("https://genhub.co.tz");
    expect(markdown).toContain("| ❌ | deployed live credentials |");
    expect(markdown).toContain("| ✅ | deployed /api/health |");
    // A skipped step must not render as a pass: it is the one line saying what
    // the run did not prove.
    expect(markdown).toContain("| ! | HarakaPay collect |");
  });

  it("says READY, and what was not proven, on a green run", () => {
    const markdown = renderMarkdown({ ...report, ready: true });
    expect(markdown).toContain("## Launch check — READY");
    expect(markdown).toContain("not proven is a real USSD push");
  });

  it("handles having no deployed site at all", () => {
    const markdown = renderMarkdown({ ready: false, url: null, steps: [] });
    expect(markdown).toContain("APP_URL` is not set");
  });
});

describe("the real USSD push stays opt-in", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "launch-check.mjs"), "utf8");

  it("is invoked only from behind the explicit --collect guard", () => {
    // Ordering, not just presence: the smoke must not be reachable on the path
    // the default run takes. Moving the call above the guard is exactly the edit
    // this test exists to catch — it would make `npm run launch:check` charge
    // whoever's number happens to be in the arguments file.
    // No trailing paren on purpose: the guard has gained conditions since it was
    // written (--wait never collects). What must not change is that the collect
    // is still gated on both arguments actually being there.
    const guard = source.indexOf("if (collectAmount && collectPhone");
    const smoke = source.indexOf('"scripts/harakapay-smoke.mjs"');
    expect(guard).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(smoke);
  });

  it("says so in the summary when it was skipped", () => {
    // The skipped line is the only place a reader learns the ONE thing a green
    // run did not prove.
    expect(source).toContain("SKIPPED — pass --collect");
  });
});

describe("the local report names the environment it read", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "preflight.mjs"), "utf8");

  it("says so when it is describing this checkout in --production mode", () => {
    // The confusion this pins down is not hypothetical: running
    // `preflight:prod` on a laptop and reading it as a verdict about the
    // deployment is the read that sends someone hunting for a variable they
    // already set in their hosting provider's dashboard. Naming the file is the
    // whole fix, so it must not be edited away.
    expect(source).toContain("this report describes THIS CHECKOUT, not your deployment");
    expect(source).toContain("launch:check:remote");
  });

  it("prints the .env.local path it actually read", () => {
    expect(source).toContain("Reading ${envFilePath}");
  });
});

describe("the scheduled deploy check runs --remote", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "post-deploy.yml"),
    "utf8"
  );

  it("asks the deployment rather than holding the production secrets", () => {
    // This is the decision the whole workflow rests on, so it is pinned rather
    // than left in a comment: a later edit that swapped --remote for the local
    // run would silently start demanding every production secret on a GitHub
    // runner, and would report on the runner's copy of them.
    expect(workflow).toContain("launch-check.mjs --remote");
  });

  it("only fires for a successful Production deployment", () => {
    expect(workflow).toContain("github.event.deployment_status.state == 'success'");
    expect(workflow).toContain("github.event.deployment.environment == 'Production'");
  });
});
