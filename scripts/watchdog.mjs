#!/usr/bin/env node
// =============================================================================
// GENHUB - Uptime watchdog
//
// Run:  node scripts/watchdog.mjs                  (APP_URL from the environment)
//       node scripts/watchdog.mjs --url https://your-domain
//
// Wired to .github/workflows/uptime.yml, hourly. `npm run watchdog` runs the
// same thing by hand, which is also the quickest post-deploy check there is.
//
// -----------------------------------------------------------------------------
// What this is for
//
// A stopped schedule is the one failure with no symptom inside the app: no
// request arrives, so there is no log line, no error and nothing to alert on.
// Every page still loads and every endpoint still answers "success" while
// creators stop being paid and renewals stop charging. The app writes a
// heartbeat per worker so the *absence* of a run is the signal — see
// Admin → Overview → Background jobs — but a dashboard only helps somebody who
// opens it, and the failure is silent at exactly the hours nobody does.
//
// So: one request to /api/health, judged by the table below, and a failed run
// (which GitHub emails about) when the answer is bad.
//
// -----------------------------------------------------------------------------
// Why the decision lives in a function and not in the workflow YAML
//
// The rules are not obvious and getting them wrong is expensive in both
// directions — a watchdog that misses an outage is useless, and one that cries
// wolf hourly gets muted, which is worse. `assessHealth` is pure, so every
// branch is covered by src/tests/watchdog.test.ts without a server.
//
// Two things it deliberately does NOT do:
//
//   * It does not alarm on `never`. A worker that has never run means no
//     scheduler is configured yet — setup work, not an outage — and the health
//     endpoint already made that call (returning 200 rather than 503). Folding
//     it in here would leave a fresh deployment alarming until someone wires a
//     scheduler, and an alarm that is always red is an alarm nobody reads.
//   * It does not ask for worker detail. /api/health publishes the verdict and
//     nothing else, on purpose, so the alert says where to look instead of
//     putting operational detail on a public endpoint.
//
// The blind spot, stated rather than hidden: GitHub disables *every* scheduled
// workflow in a repository after 60 days without activity — this one included,
// at the same moment as the four workers it watches. For that specific failure
// only a monitor outside GitHub helps, which is why /api/health answers 503.
// See PRODUCTION.md §4.0.2.
// =============================================================================

import { pathToFileURL } from "node:url";

const ALERTING_JOBS = ["late", "stalled", "failing"];

/**
 * Judge a /api/health response.
 *
 * Pure: takes the parsed body and the HTTP status, returns what to say about
 * them. No network, no clock, no process — so every branch is testable.
 *
 * @param {any} payload      parsed JSON body, or null when there was none
 * @param {number} httpStatus status code (0 when the request never completed)
 * @returns {{ ok: boolean, alarms: string[], notices: string[] }}
 */
export function assessHealth(payload, httpStatus) {
  const alarms = [];
  const notices = [];

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      alarms: [
        `the health endpoint did not answer with JSON (HTTP ${httpStatus || "no response"}) — the site may be down, or something in front of it is`,
      ],
      notices,
    };
  }

  const database = payload.checks?.database ?? "unknown";
  const jobs = payload.checks?.backgroundJobs ?? "unknown";

  if (database !== "up") {
    alarms.push(`database is ${database} — every page that reads data is failing`);
  }

  if (ALERTING_JOBS.includes(jobs)) {
    alarms.push(
      `background jobs: ${jobs} — a scheduled worker has stopped running. ` +
        "Admin → Overview → Background jobs says which one, and §4.0.1 says how the schedule is wired"
    );
  } else if (jobs === "never") {
    notices.push(
      "background jobs have never run — no scheduler is configured yet (§4.0.1). Setup, not an outage, so not an alarm."
    );
  } else if (jobs !== "ok") {
    alarms.push(`could not read the background jobs verdict (got "${jobs}")`);
  }

  // The endpoint only reports degraded for the two reasons above, so reaching
  // here means it is unhealthy for a reason this script cannot see — which is
  // exactly when a watchdog should not shrug.
  if (!alarms.length && Number(httpStatus) >= 400) {
    alarms.push(
      `the health endpoint answered HTTP ${httpStatus} while claiming status="${payload.status ?? "?"}" — it is degraded for a reason this check cannot read`
    );
  }

  // Not an alarm: a sandbox deployment is a legitimate staging setup. But on the
  // production URL it means no USSD prompt is sent and no real money moves, so
  // it is worth a line in a log somebody is already reading.
  if (payload.checks?.payments === "sandbox") {
    notices.push("payments are in SANDBOX — no USSD prompt is sent and no real money moves");
  }

  return { ok: alarms.length === 0, alarms, notices };
}

/** One line for a chat webhook or an email subject. */
export function alertMessage(baseUrl, report) {
  return `Genhub ${baseUrl} — ${report.alarms.join("; ")}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  const baseUrl = (
    urlIndex !== -1 ? args[urlIndex + 1] || "" : process.env.APP_URL || ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (!baseUrl) {
    // Skips clean rather than failing, like the four worker workflows: not
    // configured yet is not the same as broken.
    console.log("APP_URL is not set — nothing to watch. See PRODUCTION.md §4.0.1.");
    process.exit(0);
  }

  console.log(`\n=== GENHUB WATCHDOG ===\n`);
  console.log(`Checking ${baseUrl}/api/health\n`);

  const { httpStatus, payload, error } = await fetchHealth(`${baseUrl}/api/health`);
  const report = error
    ? {
        ok: false,
        alarms: [
          `could not reach ${baseUrl}/api/health after 3 attempts (${error.message || error})`,
        ],
        notices: [],
      }
    : assessHealth(payload, httpStatus);

  for (const notice of report.notices) console.log(`  ! ${notice}`);
  for (const alarm of report.alarms) console.log(`  ✗ ${alarm}`);
  if (report.ok) {
    console.log(
      `  ✓ status=${payload.status}, database=${payload.checks?.database}, backgroundJobs=${payload.checks?.backgroundJobs}`
    );
  }

  const alertUrl = (process.env.ALERT_WEBHOOK_URL || "").trim();
  if (!report.ok && alertUrl) {
    const message = alertMessage(baseUrl, report);
    try {
      const res = await fetch(alertUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `text` is Slack's field, `content` is Discord's; each ignores the other.
        body: JSON.stringify({ text: message, content: message }),
        signal: AbortSignal.timeout(15_000),
      });
      console.log(
        res.ok
          ? `\n  ✓ alert sent (HTTP ${res.status})`
          : `\n  ! alert webhook answered HTTP ${res.status} — the alert was not delivered`
      );
    } catch (alertError) {
      console.log(`\n  ! could not reach the alert webhook: ${alertError.message || alertError}`);
    }
  }

  if (!report.ok) {
    // A non-zero exit is the alarm: GitHub emails the repository owner when a
    // scheduled run fails, and the failure is visible in the Actions tab.
    console.log(`\n=== ${report.alarms.length} PROBLEM(S) — alerting ===\n`);
    process.exit(1);
  }

  console.log("\n=== PASS ===\n");
  process.exit(0);
}

/**
 * GET the health endpoint, retrying a couple of times.
 *
 * A single dropped request is not an outage, and a watchdog that pages on one
 * is a watchdog that gets muted. Three attempts, five seconds apart: still
 * catching a real outage within the same minute, no longer fooled by a blip.
 */
async function fetchHealth(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      // A response is an answer even when it is a 503 with a body — the status
      // and the body together are what `assessHealth` judges.
      return { httpStatus: res.status, payload: await res.json().catch(() => null) };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  return { httpStatus: 0, payload: null, error: lastError };
}
