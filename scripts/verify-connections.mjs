#!/usr/bin/env node
// =============================================================================
// GENHUB - Prove every credential actually WORKS
// Run:  npm run verify:live
//
// `preflight:prod` answers "did you set this?". This answers the harder
// question: "does it work?" — by opening a real connection to each service.
//
// Why both are needed: a connection string with a typo, an API key from the
// sandbox account, a Bunny token-authentication key that was never switched on,
// a database that needs ?sslmode=require — all of them LOOK configured. The
// difference only shows up when something tries to use them, and the worst time
// to find out is after a customer has paid.
//
// Every check here is READ-ONLY or self-cleaning:
//   Postgres  SELECT 1
//   Redis     PING
//   Bunny     library lookup (GET)
//   CDN       HEAD on the pull-zone hostname
//   SMTP      transport verify (opens a session, sends nothing)
//   HarakaPay GET /api/v1/balance
//   App URL   GET /api/health
//
// Exit codes: 0 = everything configured works. 1 = something configured is
// broken. Missing values are reported as "not configured" and never fail the
// run, so this is usable mid-setup.
// =============================================================================

import { loadEnv, assessSecret } from "./_env.mjs";

loadEnv();

const env = (k) => (process.env[k] || "").trim();
const isLocal = (v) => /localhost|127\.0\.0\.1/i.test(v || "");

const GREEN = "\u2713";
const RED = "\u2717";
const AMBER = "!";
const DIM = "\u00b7";

const results = [];
function record({ name, state, detail }) {
  results.push({ name, state, detail });
  const mark = state === "ok" ? GREEN : state === "fail" ? RED : AMBER;
  const label = state === "skip" ? "skip" : state.toUpperCase();
  console.log(`  ${mark} ${name.padEnd(14)} ${label.padEnd(6)} ${detail || ""}`);
}

const timeout = (ms) => AbortSignal.timeout(ms);

// =============================================================================
// 1. Postgres
// =============================================================================
async function checkDatabase() {
  const url = env("DATABASE_URL");
  if (!url) return record({ name: "Postgres", state: "skip", detail: "DATABASE_URL not set" });

  // The mistake that costs an afternoon: serverless + a direct (non-pooled)
  // Neon/Supabase connection exhausts connections and fails under load, not at
  // build time. Worth flagging loudly while it is cheap to fix.
  if (/neon\.tech|supabase\.co|render\.com|aiven\.io/.test(url) && !/sslmode=/.test(url)) {
    record({
      name: "Postgres",
      state: "warn",
      detail: "managed host without ?sslmode=require — add it, most managed providers reject plaintext",
    });
  }
  if (/neon\.tech/.test(url) && !/-pooler/.test(url)) {
    console.log(
      `       ${AMBER} Neon: this is the DIRECT connection. On Vercel use the POOLED one\n` +
        `         (host contains "-pooler") — a serverless app opens a connection per\n` +
        `         instance and will exhaust the direct limit under load.`
    );
  }

  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const rows = await prisma.$queryRawUnsafe("SELECT 1 AS ok");
    const users = await prisma.user.count().catch(() => null);
    const migrations = await prisma
      .$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = '_prisma_migrations'`
      )
      .catch(() => [{ n: 0 }]);
    await prisma.$disconnect();

    const hasMigrations = migrations?.[0]?.n > 0;
    record({
      name: "Postgres",
      state: rows?.[0]?.ok === 1 ? "ok" : "fail",
      detail:
        `connected${isLocal(url) ? " (LOCAL — fine for now, move it before launch)" : ""}` +
        ` · users: ${users ?? "?"}` +
        `${hasMigrations ? "" : ` · ${AMBER} no _prisma_migrations table — run npm run db:deploy`}`,
    });
  } catch (error) {
    record({ name: "Postgres", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

// =============================================================================
// 2. Redis
// =============================================================================
/**
 * Upstash REST probe. Same discipline as the TCP path below: PING alone is not
 * enough, because the app writes (INCR/SETEX) and a server can answer reads
 * while refusing writes.
 */
async function checkRedisRest(url, token) {
  const command = async (args) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  };

  try {
    const pong = await command(["PING"]);
    if (pong !== "PONG") throw new Error(`PING -> ${pong}`);

    const probeKey = `genhub:verify:${Date.now()}`;
    await command(["SET", probeKey, "1", "PX", 5000]);
    await command(["DEL", probeKey]);

    record({
      name: "Redis",
      state: "ok",
      detail: "PING + write OK · Upstash REST (HTTPS)",
    });
  } catch (error) {
    record({
      name: "Redis",
      state: "fail",
      detail: `Upstash REST: ${String(error.message || error).slice(0, 150)}`,
    });
  }
}

async function checkRedis() {
  const restUrl = env("UPSTASH_REDIS_REST_URL");
  const restToken = env("UPSTASH_REDIS_REST_TOKEN");

  // Upstash REST wins when present, matching src/lib/redis.ts. Checked first so
  // this probe reports on the backend the app will actually use.
  if (restUrl && restToken) return checkRedisRest(restUrl, restToken);
  if (restUrl || restToken) {
    return record({
      name: "Redis",
      state: "fail",
      detail: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — only one is set, both are required",
    });
  }

  const url = env("REDIS_URL");
  if (!url) {
    return record({
      name: "Redis",
      state: "skip",
      detail: "no managed Redis configured (UPSTASH_REDIS_REST_* or REDIS_URL)",
    });
  }

  const isLocalRedis = isLocal(url);
  let client;
  try {
    const { default: Redis } = await import("ioredis");
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 10_000,
      retryStrategy: () => null,
    });

    const pong = await client.ping();
    if (pong !== "PONG") {
      throw new Error(`PING -> ${pong}`);
    }

    // PING proves the server is up, but the app never runs PING — it runs INCR
    // and SETEX. A server that answers reads while rejecting writes is the exact
    // failure mode of Redis MISCONF, and it would silently downgrade rate
    // limiting to per-instance in-memory buckets. So test a real write.
    const probeKey = `genhub:verify:${Date.now()}`;
    await client.set(probeKey, "1", "PX", 5000);
    await client.del(probeKey);

    record({
      name: "Redis",
      state: "ok",
      detail:
        `PING + write OK` +
        (/^rediss:\/\//.test(url) ? " · TLS on" : ` · ${AMBER} plaintext redis:// — use rediss:// in production`),
    });
  } catch (error) {
    const message = String(error.message || error);
    if (/MISCONF|not able to persist|read-only|READONLY/i.test(message)) {
      // The server is reachable; it just refuses writes. Locally that is a disk
      // permission quirk. On managed Redis it is a real incident.
      record({
        name: "Redis",
        state: isLocalRedis ? "warn" : "fail",
        detail:
          "reachable but REJECTING WRITES (MISCONF)" +
          (isLocalRedis
            ? " — local dev server cannot persist to disk. Rate limits fall back to in-memory (the app fails open, so nothing breaks)."
            : " — rate limiting will silently fall back to per-instance buckets, so the limit no longer holds across instances."),
      });
    } else {
      record({ name: "Redis", state: "fail", detail: message.slice(0, 150) });
    }
  } finally {
    try {
      await client?.quit();
    } catch {
      /* already gone */
    }
  }
}

// =============================================================================
// 3. Bunny Stream + CDN
// =============================================================================
async function checkBunnyStream() {
  const key = env("BUNNY_STREAM_API_KEY");
  const library = env("BUNNY_STREAM_LIBRARY_ID");
  if (!key || !library) {
    return record({
      name: "Bunny Stream",
      state: "skip",
      detail: "BUNNY_STREAM_API_KEY / BUNNY_STREAM_LIBRARY_ID not set",
    });
  }

  try {
    const res = await fetch(`https://video.bunnycdn.com/library/${library}`, {
      headers: { AccessKey: key },
      signal: timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      record({
        name: "Bunny Stream",
        state: "fail",
        detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 110)}` +
          (res.status === 401 || res.status === 403 ? " · wrong key, or it lacks access to this library" : ""),
      });
      return;
    }

    // The setting that silently breaks paid playback: without Token
    // Authentication the signature in the URL is ignored, so anyone who copies a
    // link can watch a video they never bought.
    const tokenAuth =
      body?.TokenAuthenticationEnabled ?? body?.tokenAuthenticationEnabled ?? null;
    const signed = !!env("BUNNY_TOKEN_SECRET");

    record({
      name: "Bunny Stream",
      state: tokenAuth === false ? "fail" : "ok",
      detail:
        `library "${body.name || library}" · plan ${body.plan ?? "?"} · videos ${body.totalVideos ?? "?"}` +
        (tokenAuth === false
          ? ` · ${RED} Token Authentication is OFF — paid videos are unprotected. Turn it ON in Stream → Security.`
          : tokenAuth === true
            ? " · Token Auth ON"
            : ""),
    });
    if (tokenAuth === true && !signed) {
      record({
        name: "Bunny token",
        state: "fail",
        detail: "Token Auth is ON but BUNNY_TOKEN_SECRET is empty — playback URLs will not be accepted",
      });
    }
  } catch (error) {
    record({ name: "Bunny Stream", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

async function checkCdn() {
  const host = env("BUNNY_CDN_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!host) return record({ name: "Bunny CDN", state: "skip", detail: "BUNNY_CDN_HOSTNAME not set" });

  try {
    const res = await fetch(`https://${host}/`, { method: "HEAD", signal: timeout(15_000) });
    record({
      name: "Bunny CDN",
      // Any HTTP answer (even 403) proves DNS + TLS work, which is what we are
      // testing here; the token itself is validated by playback.
      state: "ok",
      detail: `${host} answered HTTP ${res.status}`,
    });
  } catch (error) {
    record({
      name: "Bunny CDN",
      state: "fail",
      detail: `${host} did not resolve/answer — check the pull-zone hostname (${String(error.message || error).slice(0, 80)})`,
    });
  }
}

// =============================================================================
// 4. SMTP (sends nothing — verify() just opens the session)
// =============================================================================
async function checkSmtp() {
  const host = env("SMTP_HOST");
  if (!host) {
    return record({
      name: "SMTP",
      state: "skip",
      detail: "SMTP_HOST not set — password reset emails only reach the server log",
    });
  }

  try {
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
    record({
      name: "SMTP",
      state: from ? "ok" : "warn",
      detail:
        `${host}:${port} authenticated` +
        (from ? ` · from ${from}` : ` · ${AMBER} EMAIL_FROM not set (falls back to no-reply@genhub.local, which providers reject)`),
    });
  } catch (error) {
    record({ name: "SMTP", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

// =============================================================================
// 5. HarakaPay
// =============================================================================
async function checkHarakapay() {
  const key = env("HARAKAPAY_API_KEY");
  if (!key) return record({ name: "HarakaPay", state: "skip", detail: "HARAKAPAY_API_KEY not set" });

  const base = env("HARAKAPAY_BASE_URL") || "https://harakapay.net";
  try {
    const res = await fetch(`${base}/api/v1/balance`, {
      headers: { "X-API-Key": key },
      signal: timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.success === false) {
      record({
        name: "HarakaPay",
        state: "fail",
        detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 110)} — key rejected`,
      });
      return;
    }

    const float = Number(body.float_balance ?? 0);
    record({
      name: "HarakaPay",
      state: float > 0 ? "ok" : "fail",
      detail:
        `key valid · wallet ${body.wallet_balance ?? 0} · float ${float}` +
        (float <= 0
          ? ` · ${RED} float is 0: accepts collects and reports "USSD push sent", but orders never settle`
          : ""),
    });
  } catch (error) {
    record({ name: "HarakaPay", state: "fail", detail: String(error.message || error).slice(0, 150) });
  }
}

// =============================================================================
// 6. The deployed app itself
// =============================================================================
async function checkAppUrl() {
  const url = env("NEXT_PUBLIC_APP_URL");
  if (!url) return record({ name: "App URL", state: "skip", detail: "NEXT_PUBLIC_APP_URL not set" });

  if (isLocal(url)) {
    return record({
      name: "App URL",
      state: "warn",
      detail: `${url} — HarakaPay cannot reach a localhost webhook (polling still settles payments)`,
    });
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    record({
      name: "App URL",
      state: res.ok ? "ok" : "fail",
      detail: `${url}/api/health -> HTTP ${res.status}${body?.status ? ` (${body.status})` : ""}`,
    });
  } catch (error) {
    record({
      name: "App URL",
      state: "fail",
      detail: `${url} unreachable (${String(error.message || error).slice(0, 90)})`,
    });
  }
}

// =============================================================================
// 7. Local secrets: strength, not connectivity
// =============================================================================
function checkSecrets() {
  for (const [name, value] of [
    ["JWT_SECRET", env("JWT_SECRET")],
    ["CRON_SECRET", env("CRON_SECRET")],
    ["Webhook token", env("HARAKAPAY_WEBHOOK_TOKEN")],
  ]) {
    const assessed = assessSecret(value);

    if (assessed.ok) {
      record({
        name,
        state: "ok",
        detail: `${value.length} chars, ${assessed.entropy.toFixed(2)} bits/char`,
      });
      continue;
    }

    // A placeholder is only tolerable while it stays local; the danger is
    // carrying the same value into production, where it becomes a published key.
    const productionRelevant = env("NODE_ENV") === "production" || !isLocal(env("NEXT_PUBLIC_APP_URL"));
    record({
      name,
      state: productionRelevant ? "fail" : "warn",
      detail:
        `${assessed.reason}. ` +
        (productionRelevant
          ? "Anyone who guesses this can forge sessions — rotate with: openssl rand -hex 32"
          : "fine while it stays local, but never carry this value into production"),
    });
  }

  const sandbox = env("PAYMENT_SANDBOX");
  const legalName = env("NEXT_PUBLIC_COMPANY_LEGAL_NAME");
  const legalAddress = env("NEXT_PUBLIC_COMPANY_ADDRESS");

  record({
    name: "Live payments",
    state: sandbox === "false" ? "ok" : "warn",
    detail:
      sandbox === "false"
        ? "PAYMENT_SANDBOX=false — real USSD pushes"
        : `PAYMENT_SANDBOX=${sandbox || "(unset)"} — no real charge is ever attempted`,
  });

  // 18 U.S.C. 2257 / 28 C.F.R. 75.2: the records-custodian statement on /2257 is
  // a legal filing, not decoration. Selling adult content without a named
  // entity and a real place of business is a criminal exposure, not a bug.
  const legalOk = !!(legalName && legalAddress);
  record({
    name: "2257 records",
    state: legalOk ? "ok" : "fail",
    detail: legalOk
      ? `${legalName} · ${legalAddress.slice(0, 40)}`
      : `missing ${[!legalName && "NEXT_PUBLIC_COMPANY_LEGAL_NAME", !legalAddress && "NEXT_PUBLIC_COMPANY_ADDRESS"].filter(Boolean).join(" + ")} — /2257 cannot name a records custodian`,
  });
}

// =============================================================================
// Run
// =============================================================================
console.log("\n=== GENHUB connection check === (this opens real connections)\n");

await checkDatabase();
await checkRedis();
await checkBunnyStream();
await checkCdn();
await checkSmtp();
await checkHarakapay();
await checkAppUrl();
checkSecrets();

const failed = results.filter((r) => r.state === "fail");
const warned = results.filter((r) => r.state === "warn");
const skipped = results.filter((r) => r.state === "skip");

console.log("");
if (skipped.length) {
  console.log(`${DIM} Not configured yet (${skipped.length}): ${skipped.map((r) => r.name).join(", ")}`);
}
console.log(
  `\n${failed.length === 0 ? "Everything configured is working." : `${failed.length} configured value(s) are broken.`}` +
    (warned.length ? ` ${warned.length} warning(s) — see ${AMBER} above.` : "") +
    "\n"
);

process.exit(failed.length > 0 ? 1 : 0);
