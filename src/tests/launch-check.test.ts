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

import { summarizePreflight, summarizeVerify } from "../../scripts/launch-check.mjs";

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

describe("the real USSD push stays opt-in", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "launch-check.mjs"), "utf8");

  it("is invoked only from behind the explicit --collect guard", () => {
    // Ordering, not just presence: the smoke must not be reachable on the path
    // the default run takes. Moving the call above the guard is exactly the edit
    // this test exists to catch — it would make `npm run launch:check` charge
    // whoever's number happens to be in the arguments file.
    const guard = source.indexOf("if (collectAmount && collectPhone)");
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
