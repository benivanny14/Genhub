// =============================================================================
// GENHUB - Launch configuration check (server-side)
//
// Answers two different questions, because they have different failure modes:
//
//   1. "Have you collected this?"  -> assessSetup()      (reads .env.local)
//   2. "Does it actually work?"    -> runLiveProbes()    (opens connections)
//
// A connection string with a typo LOOKS configured. An API key from the sandbox
// account LOOKS configured. The difference only appears when something uses it,
// and the worst moment to discover it is after a customer has paid. Both halves
// live here so the admin page can show them together.
//
// The checklist itself lives in ./setup-checklist.json, which the terminal
// script reads too - the two used to hold their own copies and could disagree.
//
// SECURITY: the result of assessSetup() is rendered in a browser. Values marked
// `sensitive` are therefore summarised ("64 characters"), never echoed. An admin
// page that prints API keys into HTML leaks them into screenshots, browser
// history and shared screens.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

import checklist from "./setup-checklist.json";
import prisma from "./db";
import { verifyRedisWritable, redisBackendName, redisDataCallState } from "./redis";
import { harakaBreakerNotice } from "./payments/harakapay";
import { assessFloat, floatFloorTzs } from "./services/harakapay-float-alert.service";
import { bunnyWebhookUrl, lastBunnyWebhookDelivery } from "./services/bunny-webhook.service";
import { isR2Configured, presignR2Delete, presignR2Put } from "./r2-sign";
import config from "./config";

// ---------------------------------------------------------------- checklist
export interface ChecklistItem {
  id: string;
  key: string | null;
  /**
   * Variables that satisfy the same requirement, first match wins. Upstash hands
   * out two pairs (REST and TCP) and either is valid, so an item that demanded
   * one specific name would report "not set yet" to someone who had already set
   * the other — the drift this checklist exists to prevent. Each alternative
   * carries its OWN rules, because a TCP URL must be `rediss://` while the REST
   * URL is `https://`.
   */
  anyOf?: { key: string; must?: string; mustHint?: string }[];
  title: string;
  site: string;
  steps: string[];
  example?: string;
  must?: string;
  mustHint?: string;
  forbid?: string;
  forbidHint?: string;
  sensitive?: boolean;
}

export interface ChecklistGroup {
  id: string;
  title: string;
  cost: string;
  time: string;
  blurb: string;
  items: ChecklistItem[];
}

export const SETUP_GROUPS = checklist.groups as ChecklistGroup[];
export const SETUP_ITEMS: ChecklistItem[] = SETUP_GROUPS.flatMap((g) => g.items);

// The classification rules are data too, in the same file, so the terminal
// script and this module cannot drift apart. They did: written twice, they
// disagreed on the first real value either of them saw (.env.local held
// BUNNY_TOKEN_SECRET="dev-token-secret-..."; the app called it configured and
// the script called it a placeholder). One source, compiled by both.
const RULES = (checklist as { rules: { placeholder: string; local: string } }).rules;

// ------------------------------------------------------------------- states
export type ItemState =
  /** present and plausible */
  | "ok"
  /** not set at all */
  | "missing"
  /** reads like a stopgap someone typed to get moving */
  | "placeholder"
  /** set, but points at this machine - fatal for a deployed site */
  | "local"
  /** set, but fails the format this value must have */
  | "wrong";

export interface SetupItemView extends ChecklistItem {
  state: ItemState;
  /**
   * True for a step with no environment variable — work in somebody else's
   * dashboard. The app can never detect whether it is done, so an admin marks
   * it off by hand (see the SetupStep table).
   */
  manual?: boolean;
  /** A manual step an admin has ticked off. */
  manualDone?: boolean;
  /** a safe-to-display summary; null when nothing is set */
  display: string | null;
  hint?: string;
  /**
   * The value was written to .env.local after the server started, so this
   * process is still running on the old one. The most common confusion is
   * "I saved it and nothing changed" - this is why.
   */
  restartPending: boolean;
}

export interface SetupGroupView extends Omit<ChecklistGroup, "items"> {
  items: SetupItemView[];
}

export interface SetupReport {
  groups: SetupGroupView[];
  /**
   * `todo` counts what the app can SEE is unfinished (a variable missing, local
   * or wrong). `manual` counts dashboard steps nobody has ticked off yet.
   *
   * They are separate numbers because only one of them could ever have been
   * zero before this: a manual step has no variable, so it was counted as todo
   * forever — which is why the admin Setup badge sat at a number that opening
   * the tab, reading everything and doing everything could not clear.
   */
  summary: { done: number; todo: number; manual: number; restartPending: number };
  envFile: { path: string; present: boolean };
}

// ------------------------------------------------------------- env parsing
// Same rules as scripts/_env.mjs and the app's own loader (@next/env, via
// dotenv): quoted values keep everything verbatim, unquoted values end at an
// inline ` #comment`. If this drifted, the page would report a clean URL while
// the app saw one with a comment stuck on the end.
function stripInlineComment(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1);
  if (quoted) return value.slice(1, -1);

  const hash = value.search(/(^|\s)#/);
  if (hash !== -1) value = value.slice(0, hash);
  return value.trim();
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = stripInlineComment(match[2].trim());
  }
  return out;
}

function readEnvFile(): { path: string; present: boolean; values: Record<string, string> } {
  const file = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return { path: file, present: false, values: {} };
  try {
    return { path: file, present: true, values: parseEnvFile(fs.readFileSync(file, "utf8")) };
  } catch {
    return { path: file, present: false, values: {} };
  }
}

// ------------------------------------------------------------ classification
// Deliberately narrow, and the narrowness is the point. The obvious pattern
// (`test`, `dev`, `default`, `xxx`) fires on values that are perfectly real:
// Upstash hands out `rediss://default:<pw>@...`, and a library honestly named
// "genhub-test" is a correct configuration. Reporting those as placeholders
// sends an operator hunting for a mistake they did not make.
const PLACEHOLDER_PATTERN = new RegExp(RULES.placeholder, "i");
const LOCAL_PATTERN = new RegExp(RULES.local, "i");

/**
 * Decide what an operator needs to know about one value, without judging
 * strength the way preflight does for the three signing secrets - this is about
 * "is it collectable yet", and it must be readable to a non-technical owner.
 */
export function classifyValue(
  value: string,
  item: Pick<ChecklistItem, "key" | "must" | "forbid" | "sensitive">
): { state: ItemState } {
  if (!value) return { state: "missing" };

  // Order matters, and it is not arbitrary. "Still points at your laptop" and
  // "someone typed a stopgap here" are both more precise diagnoses than "this
  // substring is missing", and a value like http://localhost:3000 fails the
  // must-contain-https rule too - reported in the wrong order it would tell an
  // operator their URL has the wrong scheme when the real problem is that it is
  // local, which is fine on a laptop and fatal once deployed.
  if (item.forbid && value.includes(item.forbid)) return { state: "wrong" };
  if (PLACEHOLDER_PATTERN.test(value)) return { state: "placeholder" };
  if (LOCAL_PATTERN.test(value)) return { state: "local" };
  if (item.must && !value.includes(item.must)) return { state: "wrong" };

  // A bare domain in NEXT_PUBLIC_APP_URL breaks webhook callbacks and SEO tags
  // silently, so a real scheme is not optional here.
  if (item.key === "NEXT_PUBLIC_APP_URL" && !/^https:\/\//.test(value)) return { state: "wrong" };

  return { state: "ok" };
}

/** What the browser is allowed to see for this value. */
export function summariseValue(value: string, sensitive?: boolean): string | null {
  if (!value) return null;
  if (sensitive) return `set · ${value.length} characters`;
  return value.length > 70 ? `${value.slice(0, 67)}...` : value;
}

const STATE_HINT: Record<ItemState, string | undefined> = {
  ok: undefined,
  missing: "Not set yet.",
  placeholder: "Looks like a placeholder someone typed as a stopgap - replace it with a real value.",
  local:
    "Points at this machine. Fine while you are testing, but a deployed site cannot reach it.",
  wrong: undefined,
};

// ------------------------------------------------------------------- assess
export function assessSetup(doneManualSteps: Iterable<string> = []): SetupReport {
  const file = readEnvFile();
  const manualDone = new Set(doneManualSteps);

  let doneCount = 0;
  let todo = 0;
  let manual = 0;
  let restartCount = 0;

  const groups: SetupGroupView[] = SETUP_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      // A manual step has no env var: it is work in someone else's dashboard,
      // and the only evidence it was done is an admin saying so. Counted as its
      // own kind rather than as todo, so the panel can tell "you have not done
      // this yet" from "the app cannot see whether you have".
      if (!item.key) {
        const isDone = manualDone.has(item.id);
        if (isDone) doneCount += 1;
        else manual += 1;
        return {
          ...item,
          state: (isDone ? "ok" : "missing") as ItemState,
          display: null,
          restartPending: false,
          manual: true,
          manualDone: isDone,
        };
      }

      // Resolve which variable this item is actually judged by: the first
      // alternative that has a value, or the item's own key when there are none.
      const candidates = item.anyOf?.length
        ? item.anyOf
        : [{ key: item.key, must: item.must, mustHint: item.mustHint }];

      let chosen = candidates[0];
      let effective = "";
      let restartPending = false;

      for (const candidate of candidates) {
        const fromFile = (file.values[candidate.key] || "").trim();
        const fromProcess = (process.env[candidate.key] || "").trim();
        if (!fromFile && !fromProcess) continue;

        chosen = candidate;
        // The file is the newest intent; process.env is what this server is
        // actually running. Prefer the file so an edit shows up immediately,
        // and raise restartPending when the two disagree.
        effective = fromFile || fromProcess;
        restartPending = !!fromFile && fromFile !== fromProcess;
        break;
      }

      // The item is reported under the variable that satisfies it, so the panel
      // tells an operator which one the app is really reading.
      if (effective) item = { ...item, key: chosen.key };

      const { state } = classifyValue(effective, {
        key: chosen.key,
        must: chosen.must,
        forbid: item.forbid,
        sensitive: item.sensitive,
      });
      const hint =
        state === "wrong"
          ? item.forbid
            ? item.forbidHint
            : chosen.mustHint || `Must contain "${chosen.must}".`
          : STATE_HINT[state];

      if (state === "ok") doneCount += 1;
      else todo += 1;
      if (restartPending) restartCount += 1;

      return {
        ...item,
        state,
        display: summariseValue(effective, item.sensitive),
        hint,
        restartPending,
      };
    }),
  }));

  return {
    groups,
    summary: { done: doneCount, todo, manual, restartPending: restartCount },
    envFile: { path: file.path, present: file.present },
  };
}

// --------------------------------------------------------------- live probes
export type ProbeState = "ok" | "warn" | "fail" | "skip";

export interface ProbeResult {
  id: string;
  name: string;
  state: ProbeState;
  detail: string;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);
const env = (key: string) => (process.env[key] || "").trim();

async function probeDatabase(): Promise<ProbeResult> {
  const base = { id: "database", name: "Postgres" };
  if (!env("DATABASE_URL")) {
    return { ...base, state: "skip", detail: "DATABASE_URL not set" };
  }
  try {
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>("SELECT 1 AS ok");
    const users = await prisma.user.count().catch(() => null);

    // The mistake that costs an afternoon is not "wrong password" - it is a
    // serverless deploy on a direct (non-pooled) Neon connection, which fails
    // under load rather than at build time.
    const warnings: string[] = [];
    if (/\.neon\.tech|\.supabase\.co/.test(env("DATABASE_URL")) && !/-pooler/.test(env("DATABASE_URL"))) {
      warnings.push("direct connection - switch to the pooled host before deploying");
    }

    return {
      ...base,
      state: warnings.length ? "warn" : "ok",
      detail: `connected · users: ${users ?? "?"}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`,
    };
  } catch (error) {
    return { ...base, state: "fail", detail: String((error as Error)?.message || error).slice(0, 160) };
  }
}

/**
 * The data-path breaker in words, or "" when it is healthy.
 *
 * Deliberately separate from the probe result: verification bypasses the breaker
 * on purpose, so "Redis works" and "the app is using Redis" are two different
 * facts and an operator debugging a slow site needs the second one.
 */
function redisBreakerNote(): string {
  const breaker = redisDataCallState();
  if (breaker.open) {
    return " · WARNING: the data-path breaker is OPEN — cache reads are skipped and rate limiting has fallen back to per-instance memory (see lib/redis.ts)";
  }
  if (breaker.failures > 0) {
    return ` · note: ${breaker.failures} recent data-path failure(s) — the breaker opens after 2`;
  }
  return "";
}

async function probeRedis(): Promise<ProbeResult> {
  const base = { id: "redis", name: "Redis" };
  const hasRest = Boolean(env("UPSTASH_REDIS_REST_URL") && env("UPSTASH_REDIS_REST_TOKEN"));

  if (!hasRest && !env("REDIS_URL")) {
    return {
      ...base,
      state: "skip",
      detail: "Neither UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN nor REDIS_URL is set",
    };
  }
  if (env("UPSTASH_REDIS_REST_URL") && !env("UPSTASH_REDIS_REST_TOKEN")) {
    return {
      ...base,
      state: "fail",
      detail: "UPSTASH_REDIS_REST_URL is set but the token is missing — both are required",
    };
  }

  try {
    // PING proves the server is up, but the app never runs PING - it runs SETEX.
    // A server that answers reads while rejecting writes is Redis MISCONF, and it
    // would quietly downgrade rate limiting to per-instance buckets. The helper
    // does both against whichever backend is live.
    const ok = await verifyRedisWritable();
    return {
      ...base,
      // The probe proves the backend answers; the breaker says whether the data
      // path is actually using it. A backend can be healthy while every request
      // is being served around it, so both are reported together.
      state: redisDataCallState().open ? "warn" : "ok",
      detail: `${ok} · backend: ${redisBackendName()}${redisBreakerNote()}`,
    };
  } catch (error) {
    const message = String((error as Error)?.message || error);
    const readingOnly = /MISCONF|not able to persist|READONLY|read-only/i.test(message);
    return {
      ...base,
      state: readingOnly ? "warn" : "fail",
      detail: readingOnly
        ? "reachable but REJECTING WRITES - rate limits fall back to per-instance memory"
        : message.slice(0, 160),
    };
  }
}

async function probeBunny(): Promise<ProbeResult> {
  const base = { id: "bunny", name: "Bunny Stream" };
  const key = env("BUNNY_STREAM_API_KEY");
  const library = env("BUNNY_STREAM_LIBRARY_ID");
  if (!key || !library) {
    return { ...base, state: "skip", detail: "BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID not set" };
  }
  try {
    const res = await fetch(`https://video.bunnycdn.com/library/${library}`, {
      headers: { AccessKey: key },
      signal: timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ...base,
        state: "fail",
        detail:
          `HTTP ${res.status}` +
          (res.status === 401 || res.status === 403 ? " - wrong key, or it cannot reach this library" : ""),
      };
    }

    const label = String(body.name || library);
    const { probeSignedPlayback, sampleBunnyVideo } = await import("./bunny");

    // An empty library has no playback to check, and "no videos yet" is not a
    // fault — say so instead of reporting a healthy library that nobody has
    // proved can serve anything.
    const sample = await sampleBunnyVideo();
    if (!sample) {
      return { ...base, state: "ok", detail: `library "${label}" · no video to test playback with yet` };
    }

    // The setting that silently breaks paid playback: without Token
    // Authentication the signature in the URL is ignored, so a copied link
    // plays a video the viewer never bought. Read from the VIDEO, not from the
    // library — `GET /library/{id}` does not report it at all, which is how this
    // check used to pass unconditionally.
    if (sample.tokenAuthEnabled === false) {
      return {
        ...base,
        state: "fail",
        detail: `library "${label}" · Token Authentication is OFF - paid videos are unprotected (Stream -> Security)`,
      };
    }
    if (sample.tokenAuthEnabled === null) {
      return {
        ...base,
        state: "warn",
        detail: `library "${label}" · Bunny did not report the token setting; playback not verified`,
      };
    }
    if (!env("BUNNY_TOKEN_SECRET")) {
      return {
        ...base,
        state: "fail",
        detail: "Token Authentication is ON but BUNNY_TOKEN_SECRET is empty - signed URLs would be rejected",
      };
    }

    // The other silent killer: BUNNY_CDN_HOSTNAME pointing at the Stream library
    // is correct, but a host copied from somewhere else serves nothing. Bunny
    // just told us the right one for this video, so compare instead of assuming.
    const configuredHost = env("BUNNY_CDN_HOSTNAME")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    try {
      const bunnyHost = sample.thumbnailUrl ? new URL(sample.thumbnailUrl).hostname : "";
      if (bunnyHost && configuredHost && bunnyHost !== configuredHost) {
        return {
          ...base,
          state: "fail",
          detail: `BUNNY_CDN_HOSTNAME is ${configuredHost} but this library's CDN host is ${bunnyHost} - every video URL would 404/403`,
        };
      }
    } catch {
      // A thumbnailUrl we cannot parse is not worth failing over.
    }

    // Present is not the same as accepted. Token auth is on, so the ONLY way to
    // know playback will work is to sign a real manifest and fetch it: a
    // generated secret (rather than the pull zone's own key) signs URLs Bunny
    // refuses, while every other check here still reports healthy and the player
    // spins forever. See probeSignedPlayback in lib/bunny.ts.
    const playback = await probeSignedPlayback(sample.guid);
    return playback.state === "ok"
      ? { ...base, state: "ok", detail: `library "${label}" · Token Auth ON · ${playback.detail}` }
      : { ...base, state: "fail", detail: playback.detail };
  } catch (error) {
    return { ...base, state: "fail", detail: String((error as Error)?.message || error).slice(0, 160) };
  }
}

/**
 * The webhook secret, and whether Bunny has ever actually called us.
 *
 * A signature cannot be verified without seeing one, and Bunny's library API
 * cannot report the Webhook URL it is configured with, so both halves are asked
 * here from the evidence that does exist: does the secret verify a correctly
 * signed body, and when did a callback last arrive (`recordBunnyWebhookDelivery`
 * stamps every verified one). "No callback yet" is a warning rather than a
 * failure — a deployment with nothing uploaded yet has nothing to hear from —
 * but it is the one line that distinguishes a wired webhook from a hopeful one.
 */
async function probeWebhook(): Promise<ProbeResult> {
  const base = { id: "bunnyWebhook", name: "Bunny webhook" };
  const secret = env("BUNNY_STREAM_WEBHOOK_SECRET");

  if (!secret) {
    return process.env.NODE_ENV === "production"
      ? {
          ...base,
          state: "fail",
          detail:
            "BUNNY_STREAM_WEBHOOK_SECRET is not set, so production refuses every callback (401). " +
            "A finished upload still publishes, but only on the next dashboard visit or worker sweep.",
        }
      : {
          ...base,
          state: "skip",
          detail: "not set — unsigned callbacks are accepted in development only",
        };
  }

  if (secret === env("BUNNY_STREAM_API_KEY")) {
    return {
      ...base,
      state: "warn",
      // The mistake the panel exists to catch: it looks configured, and every
      // real callback is refused.
      detail:
        "this is the library's MAIN API key. Callbacks are signed with the library's Read-Only " +
        "key, so every genuine callback would be refused — copy the Read-Only key instead.",
    };
  }

  const last = await lastBunnyWebhookDelivery();
  const target = bunnyWebhookUrl(config.appUrl);

  if (!last) {
    return {
      ...base,
      state: "warn",
      detail:
        `secret set (not the main API key) but no callback has ever been recorded — set the Stream ` +
        `library's Webhook URL to ${target}, then the next finished upload appears here.`,
    };
  }

  const event = last.label ? `Status ${last.status} — ${last.label}` : "no status in the body";
  const outcome = last.matched
    ? last.published
      ? "published a video"
      : "no change to the row"
    : "no matching video";

  return {
    ...base,
    state: "ok",
    detail: `secret set · last callback ${relativeAge(last.at)} (${event}, ${outcome})`,
  };
}

/** "12 min ago" — enough for a card, and never a wall of digits. */
function relativeAge(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function probeCdn(): Promise<ProbeResult> {
  const base = { id: "cdn", name: "Bunny CDN" };
  const host = env("BUNNY_CDN_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host) return { ...base, state: "skip", detail: "BUNNY_CDN_HOSTNAME not set" };
  try {
    // Any HTTP answer - even 403 - proves DNS and TLS resolve, which is what is
    // being tested here. The token itself is validated by real playback.
    const res = await fetch(`https://${host}/`, { method: "HEAD", signal: timeout(15_000) });
    return { ...base, state: "ok", detail: `${host} answered HTTP ${res.status}` };
  } catch (error) {
    return {
      ...base,
      state: "fail",
      detail: `${host} did not resolve (${String((error as Error)?.message || error).slice(0, 90)})`,
    };
  }
}

async function probeSmtp(): Promise<ProbeResult> {
  const base = { id: "smtp", name: "Email" };
  const host = env("SMTP_HOST");
  if (!host) {
    return { ...base, state: "skip", detail: "SMTP_HOST not set - password reset emails only reach the log" };
  }
  try {
    // verify() opens a session and sends nothing.
    const { default: nodemailer } = await import("nodemailer");
    const port = Number(env("SMTP_PORT") || 587);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: env("SMTP_USER") ? { user: env("SMTP_USER"), pass: env("SMTP_PASS") } : undefined,
    });
    await transport.verify();
    transport.close();

    const from = env("EMAIL_FROM");
    return {
      ...base,
      state: from ? "ok" : "warn",
      detail:
        `${host}:${port} authenticated` +
        (from ? "" : " · EMAIL_FROM not set (providers reject the fallback sender)"),
    };
  } catch (error) {
    return { ...base, state: "fail", detail: String((error as Error)?.message || error).slice(0, 160) };
  }
}

/**
 * Budget for the balance read's two attempts, in order (ms).
 *
 * 15 s on its own was not enough. Measured against the live gateway on
 * 2026-09-29: the FIRST request on a cold connection took 11.8 s, another took
 * longer than 20 s, and a request that followed a completed one took 0.667 s.
 * The gateway pays a one-off cost — its own session with the operator network —
 * and answers quickly afterwards, so the slow thing is a cold connection, not
 * this key and not this route.
 *
 * HOW IT USED TO FAIL: one 15 s attempt put that one-off cost exactly on the
 * boundary. The probe reported "The operation was aborted due to timeout" while
 * both the key and the gateway were healthy, and because
 * `/api/health/services` is what the post-deploy check and the uptime watchdog
 * read, every deploy and every alarm went red for a fault no code change could
 * fix. An alarm that is red nearly all the time is its own failure (§4.0.2).
 *
 * THE SECOND BUDGET IS SHORT ON PURPOSE, and 15 + 12 must stay under the
 * route's `maxDuration = 30`: a probe killed mid-flight is indistinguishable
 * from an unreachable gateway, which would silence the alarm this exists to
 * raise.
 */
export const HARAKA_PROBE_TIMEOUTS_MS = [15_000, 12_000] as const;

async function probeHarakapay(): Promise<ProbeResult> {
  const base = { id: "harakapay", name: "HarakaPay" };
  const key = env("HARAKAPAY_API_KEY");
  if (!key) return { ...base, state: "skip", detail: "HARAKAPAY_API_KEY not set" };

  const url = `${env("HARAKAPAY_BASE_URL") || "https://harakapay.net"}/api/v1/balance`;

  // Two attempts at most. The retry exists for a request that never arrived —
  // see HARAKA_PROBE_TIMEOUTS_MS — so an answer that DID arrive (a rejected key,
  // an HTTP error) is returned from inside the loop rather than asked for twice.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < HARAKA_PROBE_TIMEOUTS_MS.length; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "X-API-Key": key },
        signal: timeout(HARAKA_PROBE_TIMEOUTS_MS[attempt]),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || body.success === false) {
        return { ...base, state: "fail", detail: `HTTP ${res.status} - the API key was rejected` };
      }

      // Where the float sits. This is a BALANCE on the merchant's HarakaPay
      // account, not a broken credential: the key is valid, the gateway answers,
      // and the app's collect path never reads the float — so it is reported as a
      // warning, never a failure. A `fail` here turned every deploy and uptime
      // check red for a state no code change fixes and nothing blocks on. A
      // rejected key or an unresponsive gateway still fails (the branches above
      // and below); this one only lowers the level.
      const float = Number(body.float_balance ?? 0);
      const floor = floatFloorTzs();
      const level = assessFloat(float, floor);
      // The probe proves the gateway answers *now*; the breaker says whether this
      // process has been skipping it. Both are needed: a healthy probe with an
      // open breaker means the fault is intermittent, not fixed.
      const breakerNotice = harakaBreakerNotice();
      return {
        ...base,
        state: level === "ok" && !breakerNotice ? "ok" : "warn",
        detail:
          `key valid · wallet ${body.wallet_balance ?? 0} · float ${float}` +
          (attempt > 0
            ? " · answered on the retry (its first connection is slow, not its key)"
            : "") +
          (level === "empty"
            ? " · float is 0 — top up the merchant float so collections keep settling"
            : level === "low"
              ? ` · under the ${floor} TZS floor — top up before it reaches 0`
              : "") +
          (breakerNotice ? ` · ${breakerNotice}` : ""),
      };
    } catch (error) {
      // Only a request that never produced an answer reaches here, which is the
      // one case where the extra seconds are worth spending.
      lastError = error;
    }
  }

  const breakerNotice = harakaBreakerNotice();
  return {
    ...base,
    state: "fail",
    detail:
      String((lastError as Error)?.message || lastError).slice(0, 160) +
      ` · gave up after ${HARAKA_PROBE_TIMEOUTS_MS.length} attempts` +
      (breakerNotice ? ` · ${breakerNotice}` : ""),
  };
}

/**
 * Whether this deployment's upload storage actually accepts a file.
 *
 * The one dependency in the upload path with no probe, and the one whose failure
 * is invisible until a creator has already spent their data: a wrong R2
 * credential signs a URL that R2 refuses with 403, so the browser's PUT dies with
 * nothing the creator can act on. `uploadStorageReadiness()` cannot catch it — it
 * compares variable NAMES, and an access key of 31 characters (R2 requires 32) is
 * a name that is present.
 *
 * So this signs a real PUT, sends four bytes to a key nothing reads, then deletes
 * it again. Self-cleaning like the Redis probe's write, bounded to a couple of
 * seconds, and under its own prefix so it can never collide with an upload —
 * which lives under `incoming/`.
 */
const R2_PROBE_KEY = "probes/health";

/**
 * The sentence R2 puts inside the XML body it refuses with.
 *
 * Worth the twelve lines: R2 names the field and the reason —
 * `<Message>Credential access key has length 31, should be 32</Message>` is the
 * whole diagnosis — and without it the probe reports a bare 403, which is the
 * same answer a revoked key, a wrong bucket and a blocked network all give.
 */
function r2RefusalMessage(body: string): string {
  const message = body.match(/<Message>([^<]{3,140})<\/Message>/)?.[1];
  return message ? ` — ${message}` : "";
}

async function probeR2(): Promise<ProbeResult> {
  const base = { id: "r2", name: "Upload storage (R2)" };
  if (!isR2Configured(config.r2)) {
    return {
      ...base,
      state: "skip",
      detail: "R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET not set",
    };
  }

  const now = new Date();
  const put = presignR2Put(config.r2, R2_PROBE_KEY, 120, now);

  try {
    const res = await fetch(put.url, { method: "PUT", body: "genhub", signal: timeout(8_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ...base,
        state: "fail",
        detail: `R2 refused a signed upload (HTTP ${res.status}${r2RefusalMessage(body)})`,
      };
    }
  } catch (error) {
    return {
      ...base,
      state: "fail",
      detail: `R2 unreachable (${String((error as Error)?.message || error).slice(0, 90)})`,
    };
  }

  // The question is answered; the cleanup is best-effort on purpose. A four-byte
  // marker left under `probes/` is not worth turning a working upload path red,
  // and because the key is fixed it can never accumulate.
  try {
    const del = presignR2Delete(config.r2, R2_PROBE_KEY, 120, now);
    await fetch(del.url, { method: "DELETE", signal: timeout(8_000) });
  } catch {
    /* leave it */
  }

  return { ...base, state: "ok", detail: `signed PUT accepted by bucket "${config.r2.bucket}"` };
}

/**
 * What an answer from `<appUrl>/api/health` means.
 *
 * Pure, so it can be pinned without a network — the same reason the CDN probe's
 * "any HTTP answer proves DNS resolves" rule is written down where it is.
 *
 * The bug this comes from: /api/health answers **503 while degraded**, and
 * "degraded" includes the background workers lagging. Judging this probe on
 * `res.ok` therefore made the deployment report its own job lag back to itself
 * as `Public URL -> HTTP 503` — pointing whoever read it at DNS or at
 * `NEXT_PUBLIC_APP_URL`, neither of which was wrong. The probe's actual question
 * is "does this public address answer at all", and the reason it is unhappy is
 * the business of the `database` and background-job probes, which report it once.
 *
 * So a degraded answer is a **warn**: it keeps the deployment's state visible on
 * the admin card without joining `failing`, which is what the watchdog and
 * `launch:check --remote` read as a broken service.
 */
export function classifyAppUrlAnswer(
  httpStatus: number,
  body: unknown,
  url: string
): Pick<ProbeResult, "state" | "detail"> {
  const payload = body as { status?: unknown; checks?: unknown } | null;
  const isThisApp =
    !!payload && typeof payload === "object" && "checks" in payload && "status" in payload;

  // A different site answering 200 is the dangerous case, not a 503 from ours:
  // NEXT_PUBLIC_APP_URL feeds the sitemap, OG tags and the gateway's webhook_url.
  if (!isThisApp) {
    return {
      state: "fail",
      detail:
        `${url}/api/health answered HTTP ${httpStatus} but not with this app's health payload` +
        " — is NEXT_PUBLIC_APP_URL the right domain?",
    };
  }

  const status = payload.status === "ok" ? "ok" : String(payload.status);
  return {
    state: status === "ok" ? "ok" : "warn",
    detail:
      `${url}/api/health answered HTTP ${httpStatus}` +
      (status === "ok" ? "" : ` · this deployment reports "${status}"`),
  };
}

async function probeAppUrl(): Promise<ProbeResult> {
  const base = { id: "appUrl", name: "Public URL" };
  const url = config.appUrl;
  if (!/^https:\/\//.test(url)) {
    return {
      ...base,
      state: "warn",
      detail: `${url} - HarakaPay cannot reach a localhost webhook (polling still settles payments)`,
    };
  }
  try {
    const res = await fetch(`${url}/api/health`, { signal: timeout(15_000) });
    // A response is an answer even when its status is 503, so the body is read
    // before any verdict is reached.
    const body = await res.json().catch(() => null);
    return { ...base, ...classifyAppUrlAnswer(res.status, body, url) };
  } catch (error) {
    return { ...base, state: "fail", detail: `${url} unreachable (${String((error as Error)?.message || error).slice(0, 90)})` };
  }
}

/**
 * Every check here is read-only or self-cleaning. Run in parallel: done
 * sequentially the slowest service sets the page's latency.
 */
export async function runLiveProbes(): Promise<ProbeResult[]> {
  return Promise.all([
    probeDatabase(),
    probeRedis(),
    probeR2(),
    probeBunny(),
    probeWebhook(),
    probeCdn(),
    probeSmtp(),
    probeHarakapay(),
    probeAppUrl(),
  ]);
}
