#!/usr/bin/env node
// =============================================================================
// GENHUB - Uptime watchdog
//
// Run:  node scripts/watchdog.mjs                  (APP_URL from the environment)
//       node scripts/watchdog.mjs --url https://your-domain
//       CRON_SECRET=… node scripts/watchdog.mjs     (optional — makes the alert
//                                   name the worker that stopped; see §4.0.2)
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
// What it does about the problem, not only about telling somebody
//
// With CRON_SECRET set, a worker whose schedule has stopped is started again.
// The state is named `late` only when nothing has finished for roughly four of
// the worker's own intervals, so an hourly restart restores at most the cadence
// that worker was supposed to keep — it can never run a job more often than its
// schedule would have.
//
// Three of the four workers may be restarted this way; `renew-subscriptions`
// may not, ever. It sends a USSD charge request to a fan's phone when their
// wallet cannot cover a renewal, which makes it the one run that can cost
// somebody money they did not ask to spend. A missed renewal is recoverable by a
// human at a keyboard; a duplicate charge is not. Anything the watchdog is
// unsure about is left alone — a payload that does not say a worker is safe is
// read as unsafe. The guards are on `shouldRecover`, and the reasons a stopped
// worker was left alone travel in the alert.
//
// Restarting does not silence the alarm. Running the job again does not fix the
// schedule that stopped, and an alarm that goes quiet because a repair succeeded
// is how a broken schedule stays broken for a month.
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
//   * It does not ask /api/health for worker detail, because that endpoint
//     publishes the verdict and nothing else — it is public, and a health
//     endpoint that names workers and their schedules is a map of the system
//     for anyone who asks. When CRON_SECRET is configured it asks the
//     secret-guarded sibling (/api/health/attention) instead, so the alert can
//     name the worker that stopped and how long it has been quiet. That is
//     enrichment and never a prerequisite: if the secret is absent or the call
//     fails, the alert is exactly what it was before, because an alert that
//     needs a second credential in order to fire is an alert that stops firing
//     the day that credential rotates.
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

/**
 * The stopped workers from the detail endpoint, as one phrase.
 *
 * Prefers the sentence the server built, so the alert and the dashboard cannot
 * describe the same outage in two different ways. Falls back to naming the
 * workers if only the list arrived.
 *
 * @param {any} detail the parsed `data` from /api/health/attention
 * @returns {string} "" when there is nothing usable, which is a normal answer
 */
export function describeStoppedWorkers(detail) {
  if (!detail || typeof detail !== "object") return "";

  const summary = typeof detail.summary === "string" ? detail.summary.trim() : "";
  if (summary) return summary;

  const workers = Array.isArray(detail.workers) ? detail.workers : [];
  return workers
    .map((worker) => {
      const name = typeof worker?.name === "string" && worker.name.trim()
        ? worker.name.trim()
        : typeof worker?.id === "string"
          ? worker.id
          : "";
      if (!name) return "";
      const quietFor = Number.isFinite(worker?.silentForMinutes)
        ? ` (silent ${worker.silentForMinutes} min)`
        : "";
      return `${name}${quietFor}`;
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * One line for a chat webhook or an email subject.
 *
 * `extras` may be one string or several. They are optional on purpose: the
 * alert has to be exactly as loud with and without them, and a notification has
 * to read as a sentence rather than trailing off into a separator.
 *
 * @param {string} baseUrl
 * @param {{ alarms: string[] }} report
 * @param {string | string[]} [extras]
 * @returns {string}
 */
export function alertMessage(baseUrl, report, extras = []) {
  const alarm = `Genhub ${baseUrl} — ${report.alarms.join("; ")}`;
  const tail = (Array.isArray(extras) ? extras : [extras])
    .map((part) => (part || "").trim())
    .filter(Boolean);
  return [alarm, ...tail].join(" — ");
}

// ---------------------------------------------------------------------------
// Restarting a worker whose schedule has died
//
// The worker learns that nothing has finished for four of its own intervals and
// starts it. This is the difference between an alarm and a system that stays up
// alone, and it is deliberately the narrowest version of that idea.
//
// The list below is explicit rather than "everything that is late", because the
// failure that would matter is not a missed run — it is the watchdog starting
// something nobody asked for. A worker added next year is not restarted by an
// old watchdog until somebody adds it here on purpose.
// ---------------------------------------------------------------------------

/** Workers this script may start by itself. See the note above. */
export const RECOVERABLE_WORKERS = ["release-earnings", "reconcile-payments", "poll-encoding"];

/**
 * Is automatic restarting switched on?
 *
 * On unless said otherwise: the flag exists so an operator mid-incident can stop
 * the restarts without also giving up the alarm, and it fails closed — anything
 * unrecognised counts as off, so a typo cannot quietly arm it again.
 *
 * @param {string | undefined | null} value
 * @returns {boolean}
 */
export function recoveryEnabled(value) {
  const flag = (value || "").trim().toLowerCase();
  if (!flag) return true;
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/**
 * May this worker be started by the watchdog?
 *
 * Three conditions, all required. The middle one is the guard that matters:
 * `renew-subscriptions` sends a USSD charge request to a fan's phone when their
 * wallet cannot cover a renewal, so it is the one worker whose run can cost
 * somebody money they did not ask to spend. It is never started from here — not
 * when it is late, not when the schedule has been dead for a week. A missed
 * renewal is recoverable by a human at a keyboard; a duplicate charge is not
 * merely inconvenient, it is money taken from a customer.
 *
 * Note that the test is against `false` rather than "not true": a payload that
 * omits the flag, or a worker nobody has classified yet, is treated as if it can
 * charge a phone. Unknown must never mean "safe to start".
 *
 * The other two conditions matter as much:
 *
 *   - state must be exactly `late` — nothing has finished for roughly four of
 *     the worker's own intervals. `stalled` and `failing` both mean the job *is*
 *     being triggered and dies when it runs, so starting it again repeats the
 *     same death instead of recovering anything. `never` means no scheduler was
 *     ever wired up, which is setup work: papering over it by running the job by
 *     hand would hide the one thing that needs doing.
 *   - the id must be on the list — see above.
 *
 * Order matters for the *reason*, not for the decision: the phone guard is
 * checked first so that it is the sentence an operator reads. "Not one the
 * watchdog may start" would be true but useless about the one worker that
 * actually matters.
 *
 * @param {{ id?: string, name?: string, state?: string, sendsCustomerRequests?: boolean } | undefined} worker
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ recover: boolean, reason: string }}
 */
export function shouldRecover(worker, options = {}) {
  const id = typeof worker?.id === "string" ? worker.id : "";

  if (worker?.sendsCustomerRequests !== false) {
    return {
      recover: false,
      reason: id
        ? `${id} can send a charge request to a customer's phone, which is never done automatically`
        : "the worker did not say whether it can reach a customer's phone",
    };
  }

  if (options.enabled === false) {
    return { recover: false, reason: "automatic restarts are turned off (WATCHDOG_RECOVER)" };
  }

  if (!RECOVERABLE_WORKERS.includes(id)) {
    return {
      recover: false,
      reason: id
        ? `${id} is not one the watchdog may start`
        : "the worker did not say which one it is",
    };
  }

  if (worker.state !== "late") {
    return {
      recover: false,
      reason: `${id} is ${worker.state || "in an unknown state"}, not a stopped schedule`,
    };
  }

  return { recover: true, reason: "nothing has finished for four of its own intervals" };
}

/**
 * What this run will do about the workers that stopped.
 *
 * Returns both halves deliberately: the restarts, and the stopped workers it is
 * leaving alone with the reason. The second half is what makes the alert
 * trustworthy — somebody who sees a worker stuck on `late` and no restart
 * happening has to be told that was a decision, not something the watchdog
 * missed. Only workers that are actually stopped earn a sentence there; the
 * detail already explains the rest.
 *
 * @param {{ workers?: Array<{ id?: string, name?: string, state?: string, sendsCustomerRequests?: boolean }> } | null | undefined} detail
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ restarts: Array<{ id: string, name: string }>, held: Array<{ id: string, name: string, reason: string }> }}
 */
export function planRecoveries(detail, options = {}) {
  const enabled = options.enabled !== false;
  const workers = Array.isArray(detail?.workers) ? detail.workers : [];
  const restarts = [];
  const held = [];

  for (const worker of workers) {
    const name = typeof worker?.name === "string" && worker.name.trim()
      ? worker.name.trim()
      : typeof worker?.id === "string"
        ? worker.id
        : "a worker";
    const verdict = shouldRecover(worker, { enabled });

    if (verdict.recover) restarts.push({ id: worker.id, name });
    else if (worker?.state === "late") held.push({ id: worker?.id || "", name, reason: verdict.reason });
  }

  return { restarts, held };
}

/**
 * What a cron route answered, in one phrase.
 *
 * The four routes do not share a body shape — two answer through `api.success`
 * and two answer a bare `{ status }` — so only the parts they agree on are read,
 * and a body that is none of those is still reported as having run. A restart
 * that happened must not be described as a failure because its JSON was
 * unfamiliar.
 *
 * The refusal is looked for in both envelopes: two routes answer
 * `{ skipped, reason }` directly and two answer `api.success({ skipped, reason })`,
 * and reading only the outer one would report a skipped restart as a run that
 * happened — the one lie this function exists to prevent.
 *
 * @param {any} body
 * @returns {string}
 */
export function describeRunOutcome(body) {
  if (!body || typeof body !== "object") return "ran";

  const inner = body.data && typeof body.data === "object" ? body.data : {};
  const skipped = body.skipped === true || body.status === "skipped" || inner.skipped === true;

  if (skipped) {
    const candidate = [body.reason, inner.reason, body.message].find(
      (value) => typeof value === "string" && value.trim()
    );
    return `skipped — ${candidate ? candidate.trim() : "a run is already in flight"}`;
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  return message ? `ran — ${message}` : "ran";
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

  // Who stopped, when this runner is allowed to know — and then, if it holds the
  // secret, whether it can put any of them back on their feet. Everything here
  // happens *after* the verdict is decided: the detail and the restarts are
  // additions to an alarm that has already been called, never a reason to change
  // it. An alert must not depend on a second credential, and must not go quiet
  // because a repair succeeded either — the schedule is still broken.
  const additions = [];
  if (!report.ok) {
    const detail = await fetchWorkerDetail(baseUrl, process.env.CRON_SECRET);
    const stopped = describeStoppedWorkers(detail);
    if (stopped) {
      console.log(`\n  · ${stopped}`);
      additions.push(stopped);
    }

    const plan = planRecoveries(detail, {
      enabled: recoveryEnabled(process.env.WATCHDOG_RECOVER),
    });

    for (const worker of plan.restarts) {
      const outcome = await restartWorker(baseUrl, process.env.CRON_SECRET, worker.id);
      const line = `${outcome.ok ? "Restarted" : "Could not restart"} ${worker.name}: ${outcome.text}`;
      console.log(`  ${outcome.ok ? "✓" : "✗"} ${line}`);
      additions.push(line);
    }

    for (const worker of plan.held) {
      const line = `Left ${worker.name} alone: ${worker.reason}`;
      console.log(`  ! ${line}`);
      additions.push(line);
    }
  }

  const alertUrl = (process.env.ALERT_WEBHOOK_URL || "").trim();
  if (!report.ok && alertUrl) {
    const message = alertMessage(baseUrl, report, additions);
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
 * The per-worker detail, when this runner holds the secret for it.
 *
 * Returns null for every failure — no secret, a 401 from a deployment that never
 * set one, a timeout, a body that is not what we expect. The caller's alarm does
 * not depend on this succeeding, so a failure here must stay silent rather than
 * become an outage of its own. The 15s timeout matches the health fetch: a
 * hanging request must not hold the run open until GitHub kills it.
 */
async function fetchWorkerDetail(baseUrl, secret) {
  const token = (secret || "").trim();
  if (!token) return null;

  try {
    const res = await fetch(`${baseUrl}/api/health/attention`, {
      headers: { "x-cron-secret": token, "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    // The app answers { success, data }; a bare body is accepted too, so a
    // change of envelope cannot silence the detail without breaking the alarm.
    const detail = body?.data ?? body;
    return detail && typeof detail === "object" ? detail : null;
  } catch {
    return null;
  }
}

/**
 * Start a worker whose schedule has died.
 *
 * POSTs the worker's own cron route, which takes the same run lock and stamps
 * the same heartbeat as a scheduled run — so a restart cannot overlap a live run,
 * cannot happen twice at once, and cannot be invisible afterwards. The
 * `x-cron-origin` header is what stops a rescued run from being filed as though
 * the schedule had worked.
 *
 * Never throws. The caller's verdict is already decided, and a restart that
 * failed must not turn into an outage of its own; it is reported in the alert
 * instead, where somebody is already looking.
 */
async function restartWorker(baseUrl, secret, workerId) {
  try {
    const res = await fetch(`${baseUrl}/api/cron/${workerId}`, {
      method: "POST",
      headers: {
        "x-cron-secret": secret,
        "x-cron-origin": "watchdog",
        "cache-control": "no-cache",
      },
      // Generous, because this is the job itself — a schedule that already
      // stopped should not also be cut off by an impatient caller. Still
      // bounded, so a hung job cannot hold the run open until GitHub kills it.
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const why = typeof body?.error === "string" ? ` — ${body.error}` : "";
      return { ok: false, text: `HTTP ${res.status}${why}` };
    }

    return { ok: true, text: describeRunOutcome(body) };
  } catch (error) {
    return { ok: false, text: error?.message || String(error) };
  }
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
