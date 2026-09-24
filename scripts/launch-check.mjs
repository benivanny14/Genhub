#!/usr/bin/env node
// =============================================================================
// GENHUB - One command, one verdict, immediately after a deploy
//
// Run:  APP_URL=https://your-domain npm run launch:check
//       node scripts/launch-check.mjs --url https://your-domain
//       node scripts/launch-check.mjs --collect 1000 0712345678
//
// The post-deploy checklist is four commands in PRODUCTION.md §0 and five by the
// time you have read a red `preflight` and gone looking for why. Each one is
// right, and each one answers a different question — is it configured (with the
// live service probes), does every credential still work, does a real USSD push
// reach a handset — but run by hand, in order, from memory, the one that gets
// skipped is always the last.
//
// So this runs them in that order and prints a single verdict. It is a
// convenience, not a new source of truth: each step is the same script you would
// have run yourself, and this only reads its exit code and one summary line.
//
// -----------------------------------------------------------------------------
// The collect step is NOT part of the default run
//
// `--collect <amountTZS> <phone>` sends a REAL USSD push: money moves, and a
// person's handset rings. A post-deploy check that quietly charged somebody
// would be a much worse bug than the one it is looking for, so it never runs
// unless it is asked for by name, and saying so costs one line.
//
// Exit code: 0 only when every step that ran passed. A skipped collect is not a
// failure — it is the one step that needs a human to confirm on the handset.
// =============================================================================

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadEnv } from "./_env.mjs";

// -----------------------------------------------------------------------------
// Reading the verdicts
//
// Each script already exits non-zero on failure, so the exit code is the real
// signal — these parsers only exist to put the *number* in the summary line
// ("4 blocker(s)"), because "failed" alone sends the reader back into the output
// to find out how badly. Pure, so src/tests/launch-check.test.ts pins them
// without running anything.
// -----------------------------------------------------------------------------

const PREFLIGHT_TOTALS = /===\s*(\d+)\s+blocker\(s\),\s*(\d+)\s+warning\(s\)\s*===/;

/**
 * @param {string} output everything preflight.mjs printed
 * @returns {{ ok: boolean, detail: string }}
 */
export function summarizePreflight(output) {
  const totals = String(output || "").match(PREFLIGHT_TOTALS);
  if (!totals) {
    // No verdict line means it never finished — a crash, or a run killed
    // halfway. Reporting that as "0 blockers" is the one answer that would make
    // this whole command worse than useless.
    return { ok: false, detail: "did not finish — no verdict in the output" };
  }

  const blockers = Number(totals[1]);
  const warnings = Number(totals[2]);
  return {
    ok: blockers === 0,
    detail: `${blockers} blocker(s), ${warnings} warning(s)`,
  };
}

/**
 * @param {string} output everything verify-connections.mjs printed
 * @returns {{ ok: boolean, detail: string }}
 */
export function summarizeVerify(output) {
  const text = String(output || "");
  const warnings = Number((text.match(/(\d+)\s+warning\(s\)/) || [])[1] || 0);
  const warningNote = warnings ? ` · ${warnings} warning(s)` : "";

  if (/Everything configured is working\./.test(text)) {
    return { ok: true, detail: `every connection works${warningNote}` };
  }

  const broken = text.match(/(\d+)\s+configured value\(s\) are broken/);
  if (!broken) {
    return { ok: false, detail: "did not finish — no verdict in the output" };
  }
  return { ok: false, detail: `${broken[1]} configured value(s) broken${warningNote}` };
}

// -----------------------------------------------------------------------------
// Running the steps
// -----------------------------------------------------------------------------

/**
 * Run one of the other scripts, showing everything it prints.
 *
 * Output is inherited rather than captured so the reader watches it happen — a
 * launch check that goes silent for thirty seconds looks hung, and the whole
 * point of running it by hand is to read what it says.
 */
function runStep(args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  return { output, ms: Date.now() - started, status: result.status };
}

function banner(title) {
  console.log(`\n${"-".repeat(72)}\n${title}\n${"-".repeat(72)}\n`);
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "\nusage: APP_URL=https://your-domain npm run launch:check\n" +
        "       [--url https://your-domain]        the deployed site to probe\n" +
        "       [--collect <amountTZS> <07XXXXXXXX>]  also send one REAL USSD push\n"
    );
    return;
  }

  const urlIndex = args.indexOf("--url");
  const baseUrl = (urlIndex !== -1 ? args[urlIndex + 1] || "" : process.env.APP_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const collectIndex = args.indexOf("--collect");
  const collectAmount = collectIndex !== -1 ? (args[collectIndex + 1] || "").trim() : "";
  const collectPhone = collectIndex !== -1 ? (args[collectIndex + 2] || "").trim() : "";

  console.log("\n=== GENHUB LAUNCH CHECK ===\n");

  if (!baseUrl) {
    console.log(
      "  ✗ APP_URL is not set and no --url was given, so there is no deployed\n" +
        "    site to check. Set it first:\n\n" +
        "      APP_URL=https://your-domain npm run launch:check\n"
    );
    process.exitCode = 1;
    return;
  }

  const results = [];

  // 1. Configuration, the live service probes, and the deployed health endpoint.
  banner(`1/3  preflight:prod  ->  ${baseUrl}`);
  const preflight = runStep(["scripts/preflight.mjs", "--production", "--url", baseUrl]);
  // The exit code is what a shell would act on, so a crash with a cheerful last
  // line still fails. The parser is only for the wording.
  const preflightVerdict = summarizePreflight(preflight.output);
  results.push({
    name: `preflight:prod (${baseUrl})`,
    ok: preflight.status === 0 && preflightVerdict.ok,
    detail: preflightVerdict.detail,
  });

  // 2. Every credential, opened for real.
  banner("2/3  verify:live  ->  every credential, opened");
  const verify = runStep(["scripts/verify-connections.mjs"]);
  const verifyVerdict = summarizeVerify(verify.output);
  results.push({
    name: "verify:live",
    ok: verify.status === 0 && verifyVerdict.ok,
    detail: verifyVerdict.detail,
  });

  // 3. One real USSD push — only when asked for by name.
  if (collectAmount && collectPhone) {
    banner(`3/3  HarakaPay collect  ->  TZS ${collectAmount} to ${collectPhone}`);
    console.log(
      "  ! This sends a REAL USSD push. Money moves and the handset rings —\n" +
        "    confirm it on the phone, then check that the order settled.\n"
    );
    const collect = runStep([
      "scripts/harakapay-smoke.mjs",
      "--collect",
      collectAmount,
      collectPhone,
    ]);
    results.push({
      name: `HarakaPay collect (TZS ${collectAmount} -> ${collectPhone})`,
      ok: collect.status === 0,
      detail: collect.status === 0 ? "the push was accepted" : "the collect smoke failed",
    });
  } else {
    results.push({
      name: "HarakaPay collect",
      ok: true,
      skipped: true,
      detail:
        "SKIPPED — pass --collect <amountTZS> <07XXXXXXXX> to send one real USSD push",
    });
  }

  // --------------------------------------------------------------- verdict
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const ready = failed.length === 0;

  console.log(`\n=== LAUNCH CHECK: ${ready ? "READY" : "NOT READY"} ===\n`);
  for (const result of results) {
    const mark = result.skipped ? "!" : result.ok ? "✓" : "✗";
    console.log(`  ${mark} ${result.name.padEnd(46)} ${result.detail}`);
  }

  if (ready) {
    console.log(
      "\nThe configuration is launch-ready and every credential answered." +
        (results.some((r) => r.skipped)
          ? "\nThe one thing not proven is a real USSD push — see the skipped line above."
          : "") +
        "\n"
    );
    return;
  }

  console.log(
    "\nFix the failing steps above, then re-run. Each one prints where to get the\n" +
      "value:  SETUP.md\n"
  );
  process.exitCode = 1;
}

// Only when run as a script: this module is imported by its own test, and the
// check above must not fire there.
const isCli =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  await main();
}
