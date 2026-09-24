#!/usr/bin/env node
// =============================================================================
// GENHUB - One command, one verdict, immediately after a deploy
//
// Run:  APP_URL=https://your-domain npm run launch:check
//       node scripts/launch-check.mjs --url https://your-domain
//       node scripts/launch-check.mjs --json
//       node scripts/launch-check.mjs --collect 1000 0712345678
//
// --json prints one machine-readable object on stdout and nothing else, so a CI
// job can act on the verdict without scraping the report. The same report is
// written to $GITHUB_STEP_SUMMARY when that is set, which is what puts the
// verdict where a person actually looks for it: the run's own page. Both are
// additive — the human report is what runs by default, unchanged.
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
import { appendFileSync } from "node:fs";
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
// The verdict, as something other than a human reads it
//
// `reportToJson` is the whole point of --json: the sequence of steps, whether
// each passed, and the one flag a CI job branches on. `renderMarkdown` is the
// same information as a GitHub step summary — a deploy that went red should say
// *which* step and *how many* blockers on its own page, without anyone opening
// the raw log. Both are pure, so src/tests/launch-check.test.ts pins them.
// -----------------------------------------------------------------------------

/**
 * @param {{ ready: boolean, url: string|null, steps: Array<object> }} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const mark = (step) => (step.skipped ? "!" : step.ok ? "\u2705" : "\u274c");
  const lines = [
    `## Launch check — ${report.ready ? "READY" : "NOT READY"}`,
    "",
    report.url
      ? `Deployed site: \`${report.url}\``
      : "No deployed site to check — `APP_URL` is not set.",
    "",
    "| | Step | Result |",
    "| --- | --- | --- |",
  ];

  for (const step of report.steps) {
    lines.push(`| ${mark(step)} | ${step.name} | ${step.detail} |`);
  }
  lines.push("");

  if (report.ready) {
    lines.push(
      report.steps.some((step) => step.skipped)
        ? "Every configured service answered. The one thing not proven is a real USSD push."
        : "Every configured service answered, and every step ran."
    );
  } else {
    lines.push(
      "Fix the failing steps above, then re-run: `APP_URL=https://your-domain npm run launch:check`."
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Print the machine-readable verdict, and post it to the run's page when
 * GitHub is the one running this.
 *
 * The stdout half is gated on --json so the default run stays a report a person
 * reads. The step-summary half is not: writing it never changes what a human
 * sees, and a CI run that forgets --json should not silently lose its summary.
 */
function emitReport(report, json) {
  if (json) console.log(JSON.stringify(report, null, 2));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, renderMarkdown(report));
    } catch {
      // A summary that cannot be written must never turn a passing check red.
    }
  }
}

// -----------------------------------------------------------------------------
// --remote: ask the deployment about itself, not this laptop
//
// Running the local check after a deploy means handing the CI runner every
// production secret — the live gateway key, the database URL, the mail password
// — and then trusting that the copy in GitHub has not drifted from the one the
// deployment actually runs. When they disagree, the runner's answer is about
// the runner.
//
// So --remote asks the deployed site, at the two endpoints built for exactly
// this: /api/health (is the database up, are the schedules firing) and
// /api/health/services (do the credentials still work, live). It needs APP_URL
// and CRON_SECRET and nothing else — the same two values the hourly watchdog
// already holds.
// -----------------------------------------------------------------------------

const REMOTE_TIMEOUT_MS = 20_000;

// -----------------------------------------------------------------------------
// --wait: the few minutes after a redeploy
//
// A redeploy is not instantaneous, and until it flips, the domain still answers
// with the PREVIOUS deployment — the one whose blockers you just fixed. Run the
// check once at that moment and it reports the old site's faults, which reads
// exactly like the fix not working.
//
// So --wait re-checks on an interval until the verdict is READY, or the budget
// runs out. Bounded, because an unbounded wait in CI is a job that hangs until
// the runner kills it, and a killed job says nothing about the deployment.
// -----------------------------------------------------------------------------

const WAIT_DEFAULT_BUDGET_MS = 300_000;
const WAIT_INTERVAL_MS = 15_000;

/**
 * Read `--wait` / `--wait=<seconds>` out of the arguments.
 *
 * Pure, so src/tests/launch-check.test.ts pins the default and the bound
 * without running anything. A bare `--wait` takes the default budget; the
 * spelled-out form exists because five minutes is not always the right answer
 * (a first Vercel build can take longer).
 */
export function parseWait(args) {
  const flag = args.find((arg) => arg === "--wait" || arg.startsWith("--wait="));
  if (!flag) return { enabled: false, budgetMs: 0, intervalMs: WAIT_INTERVAL_MS };

  if (flag === "--wait") return { enabled: true, budgetMs: WAIT_DEFAULT_BUDGET_MS, intervalMs: WAIT_INTERVAL_MS };

  const seconds = Number(flag.slice("--wait=".length));
  // A typo must not silently become "wait forever": nothing, or a nonsense
  // number, falls back to the default rather than to infinity.
  const budgetMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : WAIT_DEFAULT_BUDGET_MS;
  return { enabled: true, budgetMs, intervalMs: WAIT_INTERVAL_MS };
}

/**
 * How long, in words. Minutes once past a minute: "3m05s" is read at a glance,
 * "185s" is arithmetic.
 */
export function describeDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
}

/**
 * @param {any} body the JSON /api/health answered with (it is not wrapped)
 * @param {number} httpStatus
 * @returns {{ ok: boolean, detail: string }}
 */
export function summarizeRemoteHealth(body, httpStatus) {
  if (!body || typeof body.status !== "string") {
    return { ok: false, detail: `no verdict in the answer (HTTP ${httpStatus})` };
  }

  const checks = body.checks || {};
  const detail = `database ${checks.database || "unknown"} · background jobs ${
    checks.backgroundJobs || "unknown"
  }`;
  // "degraded" is a real answer, not a missing one: the site is serving and
  // something that was working has stopped.
  return { ok: body.status === "ok", detail };
}

/**
 * @param {any} body the { success, data } envelope /api/health/services answers with
 * @param {number} httpStatus
 * @returns {{ ok: boolean, detail: string }}
 */
export function summarizeRemoteServices(body, httpStatus) {
  const data = body && body.success && body.data ? body.data : null;
  if (!data || typeof data.verdict !== "string") {
    return {
      ok: false,
      detail:
        httpStatus === 401 || httpStatus === 403
          ? "the deployment refused the request — CRON_SECRET does not match"
          : `no verdict in the answer (HTTP ${httpStatus})`,
    };
  }

  const failing = Array.isArray(data.failing) ? data.failing : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  if (failing.length === 0) {
    return {
      ok: true,
      detail: skipped.length
        ? `every configured service answered · ${skipped.length} not configured (${skipped.join(", ")})`
        : "every configured service answered",
    };
  }

  return {
    ok: false,
    detail: `${failing.length} service(s) failing — ${failing
      .map((f) => f.name || f.id)
      .join(", ")}`,
  };
}

/** One GET, bounded, that never throws — the caller decides what a failure means. */
async function fetchJson(url, headers) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { body, status: response.status, ms: Date.now() - started, error: null };
  } catch (error) {
    return { body: null, status: 0, ms: Date.now() - started, error };
  }
}

function describeFetchError(error, url) {
  const name = error && error.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `no answer within ${REMOTE_TIMEOUT_MS / 1000}s — is ${url} reachable?`;
  }
  // Node's fetch reports nearly every transport failure as the same opaque
  // "fetch failed". The part worth reading — ENOTFOUND, ECONNREFUSED, a TLS
  // complaint — is one level down, in `cause`.
  const cause = error && error.cause;
  const code = cause && (cause.code || cause.message);
  const message = (error && error.message) || String(error || "the request failed");
  const detail = code && !String(message).includes(String(code)) ? `${message} (${code})` : message;
  return String(detail).split("\n")[0];
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
function runStep(args, quiet) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  // With --json this has to stay silent: a `\u2713 Bunny Stream` printed before the
  // object is exactly what breaks the parser reading stdout.
  if (!quiet) process.stdout.write(output);
  return { output, ms: Date.now() - started, status: result.status };
}

function banner(title, quiet) {
  if (quiet) return;
  console.log(`\n${"-".repeat(72)}\n${title}\n${"-".repeat(72)}\n`);
}

/**
 * Steps 1 and 2 against this machine's own environment.
 *
 * @returns {Array<object>} the step records, in order
 */
function localSteps(baseUrl, json) {
  const results = [];

  // 1. Configuration, the live service probes, and the deployed health endpoint.
  banner(`1/3  preflight:prod  ->  ${baseUrl}`, json);
  const preflight = runStep(
    ["scripts/preflight.mjs", "--production", "--url", baseUrl],
    json
  );
  // The exit code is what a shell would act on, so a crash with a cheerful last
  // line still fails. The parser is only for the wording.
  const preflightVerdict = summarizePreflight(preflight.output);
  results.push({
    name: `preflight:prod (${baseUrl})`,
    ok: preflight.status === 0 && preflightVerdict.ok,
    detail: preflightVerdict.detail,
  });

  // 2. Every credential, opened for real.
  banner("2/3  verify:live  ->  every credential, opened", json);
  const verify = runStep(["scripts/verify-connections.mjs"], json);
  const verifyVerdict = summarizeVerify(verify.output);
  results.push({
    name: "verify:live",
    ok: verify.status === 0 && verifyVerdict.ok,
    detail: verifyVerdict.detail,
  });

  return results;
}

/**
 * Steps 1 and 2 against the deployment, over HTTP.
 *
 * @returns {Promise<Array<object>>} the step records, in order
 */
async function remoteSteps(baseUrl, json) {
  const results = [];
  const secret = (process.env.CRON_SECRET || "").trim();

  // 1. Is the deployment serving, and are its schedules firing? No secret:
  //    /api/health is the same endpoint the uptime monitor reads.
  banner(`1/2  ${baseUrl}/api/health  ->  the site on its own state`, json);
  const health = await fetchJson(`${baseUrl}/api/health`);
  const healthVerdict = health.error
    ? { ok: false, detail: describeFetchError(health.error, baseUrl) }
    : summarizeRemoteHealth(health.body, health.status);
  results.push({
    name: "deployed /api/health",
    ok: healthVerdict.ok,
    detail: healthVerdict.detail,
  });

  // 2. Do the deployment's credentials still work? This one needs the secret,
  //    because the answer names internal services. Without it there is nothing
  //    to ask, and saying so beats reporting a pass this check never earned.
  banner(`2/2  ${baseUrl}/api/health/services  ->  live credentials`, json);
  if (!secret) {
    results.push({
      name: "deployed live credentials",
      ok: false,
      detail:
        "CRON_SECRET is not set here, so the deployment cannot report its services",
    });
    return results;
  }

  const services = await fetchJson(`${baseUrl}/api/health/services`, {
    "x-cron-secret": secret,
  });
  const servicesVerdict = services.error
    ? { ok: false, detail: describeFetchError(services.error, baseUrl) }
    : summarizeRemoteServices(services.body, services.status);
  results.push({
    name: "deployed live credentials",
    ok: servicesVerdict.ok,
    detail: servicesVerdict.detail,
  });

  return results;
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  // --json: stdout carries one JSON object and nothing else, so a CI job can
  // act on the verdict instead of scraping the report.
  const json = args.includes("--json");
  // --remote: ask the deployed site, with APP_URL + CRON_SECRET instead of the
  // full secret set. See the section above.
  const remote = args.includes("--remote");
  // --wait: keep re-checking until READY or the budget runs out, for the few
  // minutes a redeploy takes to take over the domain. See the section above.
  const wait = parseWait(args);
  if (args.includes("--help")) {
    console.log(
      "\nusage: APP_URL=https://your-domain npm run launch:check\n" +
        "       [--url https://your-domain]        the deployed site to probe\n" +
        "       [--json]                          print one JSON verdict on stdout\n" +
        "       [--remote]                        ask the deployment instead of this\n" +
        "                                         laptop (needs only CRON_SECRET)\n" +
        "       [--wait[=seconds]]                re-check until READY (default 300s)\n" +
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

  if (!json) console.log("\n=== GENHUB LAUNCH CHECK ===\n");

  if (!baseUrl) {
    if (!json) {
      console.log(
        "  ✗ APP_URL is not set and no --url was given, so there is no deployed\n" +
          "    site to check. Set it first:\n\n" +
          "      APP_URL=https://your-domain npm run launch:check\n"
      );
    }
    // Not a crash: this is a verdict too, and the one a first CI run is most
    // likely to hit. A missing APP_URL should read as "not ready", not as
    // "the check itself is broken".
    emitReport(
      {
        ready: false,
        url: null,
        steps: [
          {
            name: "APP_URL",
            ok: false,
            skipped: false,
            detail: "not set — there is no deployed site to check",
          },
        ],
      },
      json
    );
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------- ask, and maybe ask again
  //
  // The loop exists for the window right after a redeploy: the domain serves the
  // previous deployment until the new one takes over, so the first answer can be
  // about a site that no longer exists. Bounded by --wait, and a single pass
  // when it is absent.
  const waitStarted = Date.now();
  let results;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    results = remote ? await remoteSteps(baseUrl, json) : localSteps(baseUrl, json);

    if (!wait.enabled) break;
    if (!results.some((r) => !r.ok && !r.skipped)) break;

    const elapsed = Date.now() - waitStarted;
    if (elapsed >= wait.budgetMs) {
      if (!json) {
        console.log(
          `\n  … still not ready after ${describeDuration(elapsed)} (${attempts} attempt(s)) — giving up.\n` +
            "    If a deploy is still building, re-run with a larger budget: --wait=600\n"
        );
      }
      break;
    }

    if (!json) {
      console.log(
        `\n  … not ready yet (${describeDuration(elapsed)} elapsed, attempt ${attempts}). ` +
          `Re-checking in ${describeDuration(wait.intervalMs)}; budget ${describeDuration(wait.budgetMs)}.\n`
      );
    }
    // Never sleep past the budget: a 15s interval under a 10s budget would spend
    // more time asleep than the operator asked for.
    const nap = Math.min(wait.intervalMs, wait.budgetMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, nap));
  }

  // 3. One real USSD push — only when asked for by name.
  //
  // Never while waiting: --wait is about reaching READY, and a step that charged
  // somebody on its second pass would be a genuinely bad surprise.
  if (collectAmount && collectPhone && !wait.enabled) {
    banner(`3/3  HarakaPay collect  ->  TZS ${collectAmount} to ${collectPhone}`, json);
    if (!json) {
      console.log(
        "  ! This sends a REAL USSD push. Money moves and the handset rings —\n" +
          "    confirm it on the phone, then check that the order settled.\n"
      );
    }
    const collect = runStep(
      [
        "scripts/harakapay-smoke.mjs",
        "--collect",
        collectAmount,
        collectPhone,
      ],
      json
    );
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
  const report = { ready, url: baseUrl, attempts, steps: results };

  if (!json) {
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
    } else {
      console.log(
        "\nFix the failing steps above, then re-run. Each one prints where to get the\n" +
          "value:  SETUP.md\n"
      );
    }
  }

  emitReport(report, json);
  if (!ready) process.exitCode = 1;
}

// Only when run as a script: this module is imported by its own test, and the
// check above must not fire there.
const isCli =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  await main();
}
